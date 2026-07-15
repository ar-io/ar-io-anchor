// The Merkle batcher (PRD semantics verbatim): N high-frequency events →
// ONE Arweave write per window, while every event keeps a standalone,
// offline-verifiable inclusion proof.
//
//   const batch = ario.batch({ maxEvents, maxAge, flushOnIdle }) // first trigger wins
//   batch.add(event).receipt()  // add is synchronous; receipt resolves at flush
//   await batch.close()         // explicit — no hidden process-exit hooks
//
// - maxAge is a wall-clock bound from the FIRST buffered event: partial
//   batches flush; a batch of one is valid.
// - flushOnIdle flushes shortly after activity stops (bursty LLM sessions);
//   the crash window is min(idle, maxAge).
// - Each batched event gets a complete signed ario.events/v1 envelope —
//   retained by the caller via its receipt, never individually uploaded. Its
//   RFC 9162 leaf hash is computed over the envelope's JCS bytes (profile
//   §6), so a receipt commits to the signature, not just the payload.
// - With the in-memory buffer, a crash loses buffered *proofs*, never data —
//   everything is re-anchorable from the caller's system. Durable-store
//   orphan recovery is parked per the PRD (revisits with the first durable
//   Store adapter).

import { auditPath, bytesToHex, leafHash, merkleRoot } from "@ar.io/proof";
import { sha256 } from "@noble/hashes/sha2";

import { buildEnvelope } from "./envelope.js";
import { RetentionError } from "./errors.js";
import {
  retentionWarnMessage,
  runPut,
  type LogStore,
  type RetentionErrorMode,
} from "./logstore.js";
import { buildEventRecord } from "./record.js";
import { type Sink, writeCheckpointSafely, writeEventSafely, writeIntentSafely } from "./sink.js";
import type { Store } from "./store.js";
import type { Environment, EventsEnvelope, EventsSubject, Signer } from "./types.js";

export interface BatchOptions {
  // Flush triggers — first one wins. At least one must be set (or rely
  // solely on explicit close(), by passing {} explicitly... no: require one).
  maxEvents?: number;
  maxAge?: number; // ms from the first buffered event
  flushOnIdle?: number; // ms after the most recent add
  // Names this batcher's checkpoint chain: context.chain_key =
  // "batcher:<name>", heads persisted via the Store.
  name?: string;
}

export interface BatchEventInput {
  type?: string;
  // Synchronous add: streams are not accepted here — pass bytes/string or a
  // pre-computed hash (batched events are small by nature).
  data?: Uint8Array | string;
  contentHash?: string;
  ref?: string;
  metadata?: Record<string, unknown>;
  eventId?: string;
}

export interface InclusionReceipt {
  // The anchored checkpoint this event is provably included in.
  checkpointTxId: string;
  checkpointEnvelope: EventsEnvelope;
  checkpointRecordBytes: Uint8Array;
  gatewayUrl: string;
  // The inclusion proof (hex), verifiable offline via @ar.io/proof's
  // verifyInclusion: leafHash → auditPath → root === checkpoint merkle_root.
  root: string;
  leafHash: string;
  leafIndex: number;
  leafCount: number;
  auditPath: string[];
  // The event's own signed envelope + committed record — the caller's
  // retention obligation (external commitment).
  eventId: string;
  contentHash: string;
  envelope: EventsEnvelope;
  envelopeBytes: Uint8Array;
  recordBytes: Uint8Array;
  environment: Environment;
  // Content retention (T9 Phase 2). Present ONLY when a logStore is configured:
  // true when the committed bytes were durably stored, false when best-effort
  // mode anchored despite a put() failure. Omitted when no logStore, so
  // receipts are byte-identical to today. Strict-mode put failures never reach
  // a receipt — the receipt REJECTS with RetentionError instead.
  contentStored?: boolean;
}

export interface AddHandle {
  // The event's stable id, known synchronously at add() (caller-supplied or
  // minted here) — the join key a sink's writeIntent row is written under,
  // available before the proof exists.
  readonly eventId: string;
  receipt(): Promise<InclusionReceipt>;
}

export interface Batch {
  add(event: BatchEventInput): AddHandle;
  // Flush whatever is buffered now (also called by timers/maxEvents).
  flush(): Promise<void>;
  // Flush everything and refuse further adds. Adapters call this on
  // shutdown; short-lived scripts must await it before exit.
  close(): Promise<void>;
  readonly size: number;
}

// Injected by createAnchorer — everything the batcher shares with single-shot
// anchoring, plus a checkpoint anchor function so upload/tag/txid logic
// lives in one place (anchorer.ts).
export interface BatcherContext {
  signer: Signer;
  subject: EventsSubject;
  environment: Environment;
  store: Store;
  anchorCheckpointEnvelope(envelopeBytes: Uint8Array): Promise<{ txId: string }>;
  // Proof retention (T9 Phase 1), injected alongside `store`. Absent → no
  // retention writes (byte-identical to today). `warn` reports sink failures.
  sink?: Sink;
  // Content retention (T9 Phase 2), injected alongside `sink`. Absent → no
  // content writes (byte-identical to today). `onRetentionError` selects the
  // strict (default) vs. best-effort ordering — only meaningful with a logStore.
  logStore?: LogStore;
  onRetentionError?: RetentionErrorMode;
  warn?: (message: string) => void;
  // Test seam (fake clock). Defaults to real timers.
  timers?: {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
    now(): number;
  };
}

interface Buffered {
  input: BatchEventInput;
  // Minted (or caller-supplied) at add(), not at flush — a sink's writeIntent
  // needs a stable key before the proof exists (T9 Phase 1 / eventId-at-add).
  eventId: string;
  contentHash: string;
  contentLength: number | undefined;
  // The EXACT bytes we hashed, kept so logStore.put() commits the same buffer
  // (undefined for a pre-computed-contentHash add — nothing to store).
  contentBytes: Uint8Array | undefined;
  // The content-retention put(), kicked off at add() and awaited at flush
  // before signing (T9 Phase 2). runPut never rejects; strict vs. best-effort
  // is decided at flush. Absent when no logStore / no bytes.
  putPromise?: Promise<{ ok: true; ref?: string } | { ok: false; error: unknown }>;
  addedAt: number;
  resolve(receipt: InclusionReceipt): void;
  reject(err: unknown): void;
  promise: Promise<InclusionReceipt>;
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

export class Batcher implements Batch {
  private buffer: Buffered[] = [];
  private windowStart: number | null = null;
  private maxAgeHandle: unknown = null;
  private idleHandle: unknown = null;
  private flushChain: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly chainKey: string;
  private readonly timers: NonNullable<BatcherContext["timers"]>;
  private readonly warn: (message: string) => void;

  constructor(
    private readonly opts: BatchOptions,
    private readonly ctx: BatcherContext,
  ) {
    if (
      opts.maxEvents === undefined &&
      opts.maxAge === undefined &&
      opts.flushOnIdle === undefined
    ) {
      throw new Error("batch: at least one of maxEvents, maxAge, flushOnIdle is required");
    }
    if (opts.maxEvents !== undefined && (!Number.isInteger(opts.maxEvents) || opts.maxEvents < 1)) {
      throw new Error("batch: maxEvents must be a positive integer");
    }
    this.chainKey = `batcher:${opts.name ?? "default"}`;
    this.warn = ctx.warn ?? ((m: string) => console.warn(m));
    this.timers = ctx.timers ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as Parameters<typeof clearTimeout>[0]),
      now: () => Date.now(),
    };
  }

  get size(): number {
    return this.buffer.length;
  }

  add(event: BatchEventInput): AddHandle {
    if (this.closed) throw new Error("batch: closed");
    if ((event.data === undefined) === (event.contentHash === undefined)) {
      throw new Error("batch.add: exactly one of data or contentHash is required");
    }

    let contentHash: string;
    let contentLength: number | undefined;
    let contentBytes: Uint8Array | undefined;
    if (event.data !== undefined) {
      const bytes =
        typeof event.data === "string" ? new TextEncoder().encode(event.data) : event.data;
      contentHash = bytesToHex(sha256(bytes));
      contentLength = bytes.length;
      contentBytes = bytes;
    } else {
      if (!SHA256_HEX_RE.test(event.contentHash!)) {
        throw new Error("batch.add: contentHash must be lowercase sha256 hex");
      }
      contentHash = event.contentHash!;
    }

    // Mint the eventId now (not at flush): the sink's writeIntent needs a
    // stable join key before the proof exists, and the handle exposes it
    // synchronously. Caller-supplied wins; buildEnvelope validates it at flush.
    const eventId = event.eventId ?? crypto.randomUUID();

    let resolve!: (r: InclusionReceipt) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<InclusionReceipt>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const entry: Buffered = {
      input: event,
      eventId,
      contentHash,
      contentLength,
      contentBytes,
      addedAt: this.timers.now(),
      resolve,
      reject,
      promise,
    };
    this.buffer.push(entry);

    // Content retention (T9 Phase 2): store the SAME bytes we hashed, kicked
    // off NOW (content is known at add()). runPut never rejects — strict vs.
    // best-effort is applied at flush, before signing, adding no latency. Only
    // concrete bytes are retainable (a contentHash-only add has none).
    if (this.ctx.logStore !== undefined && contentBytes !== undefined) {
      entry.putPromise = runPut(this.ctx.logStore, {
        eventId,
        contentHash,
        content: contentBytes,
        ...(event.ref !== undefined ? { ref: event.ref } : {}),
        ...(event.metadata !== undefined ? { metadata: event.metadata } : {}),
      });
    }

    // The durable "offered for anchoring" record (proof not yet known). Fire-
    // and-forget + safe: a sink failure warns, never blocks add() or the flush.
    // For strict-mode retention failures this intent row is the enumerable
    // signal — it is written here and never gets a proof (SELECT WHERE proof
    // IS NULL), so a dropped event is enumerable, never silent.
    writeIntentSafely(this.ctx.sink, this.warn, {
      eventId,
      contentHash,
      ...(event.ref !== undefined ? { ref: event.ref } : {}),
    });

    // Timers: maxAge anchors to the FIRST event of the window; idle resets
    // on every add. First trigger wins — flush() clears both.
    if (this.windowStart === null) {
      this.windowStart = entry.addedAt;
      if (this.opts.maxAge !== undefined) {
        this.maxAgeHandle = this.timers.setTimeout(() => void this.flush(), this.opts.maxAge);
      }
    }
    if (this.opts.flushOnIdle !== undefined) {
      if (this.idleHandle !== null) this.timers.clearTimeout(this.idleHandle);
      this.idleHandle = this.timers.setTimeout(() => void this.flush(), this.opts.flushOnIdle);
    }
    if (this.opts.maxEvents !== undefined && this.buffer.length >= this.opts.maxEvents) {
      void this.flush();
    }

    // Surface async flush failures through receipt(), never as unhandled
    // rejections from timer ticks.
    promise.catch(() => {});
    return { eventId, receipt: () => promise };
  }

  async flush(): Promise<void> {
    // A failed window surfaces ONLY through its receipts — flush()/close()
    // themselves resolve, so timer ticks never produce unhandled rejections
    // and shutdown paths that call close() unconditionally never crash.
    const run = this.flushChain.then(() => this.doFlush());
    this.flushChain = run;
    return run;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
  }

  private clearTimers(): void {
    if (this.maxAgeHandle !== null) this.timers.clearTimeout(this.maxAgeHandle);
    if (this.idleHandle !== null) this.timers.clearTimeout(this.idleHandle);
    this.maxAgeHandle = null;
    this.idleHandle = null;
  }

  private async doFlush(): Promise<void> {
    const window = this.buffer;
    if (window.length === 0) {
      this.clearTimers();
      this.windowStart = null;
      return;
    }
    const windowStart = this.windowStart ?? window[0]!.addedAt;
    this.buffer = [];
    this.windowStart = null;
    this.clearTimers();

    const strict = (this.ctx.onRetentionError ?? "skip-anchor") === "skip-anchor";

    try {
      // 0. Content retention gate (T9 Phase 2), strict order: resolve each
      //    event's content-store BEFORE anchoring. The puts were kicked off at
      //    add() and ran concurrently while the window filled, so awaiting them
      //    here adds no anchoring latency. Partition the window into events
      //    that proceed to anchor and strict retention failures that must not.
      const proceeding: {
        entry: Buffered;
        effectiveRef: string | undefined;
        contentStored: boolean | undefined;
      }[] = [];
      const retentionFailures: { entry: Buffered; error: unknown }[] = [];
      for (const entry of window) {
        let putRef: string | undefined;
        let contentStored: boolean | undefined;
        if (entry.putPromise !== undefined) {
          const res = await entry.putPromise;
          if (res.ok) {
            contentStored = true;
            putRef = res.ref;
          } else if (strict) {
            retentionFailures.push({ entry, error: res.error });
            continue; // do NOT anchor an event whose content did not store
          } else {
            contentStored = false; // best-effort: anchor anyway, flagged
            this.warn(retentionWarnMessage(entry.eventId, res.error));
          }
        }
        // payload_ref / ref binding: caller-supplied ref WINS; the logStore ref
        // fills only when the caller left it empty.
        const effectiveRef = entry.input.ref ?? putRef;
        proceeding.push({ entry, effectiveRef, contentStored });
      }

      // Strict retention failures never anchor — but they are NOT silent: the
      // receipt rejects LOUDLY with RetentionError, and the add()-time sink
      // intent row (written before the put resolved) never gets a proof, so
      // the event stays enumerable (SELECT WHERE proof IS NULL).
      for (const { entry, error } of retentionFailures) {
        entry.reject(new RetentionError(entry.eventId, error));
      }

      // Every event in the window failed strict retention → nothing to anchor.
      if (proceeding.length === 0) return;

      // 1. A complete signed envelope per proceeding event (leaf envelopes —
      //    retained via receipts, never uploaded).
      const leaves: {
        entry: Buffered;
        effectiveRef: string | undefined;
        contentStored: boolean | undefined;
        envelope: EventsEnvelope;
        envelopeBytes: Uint8Array;
        recordBytes: Uint8Array;
        leafHash: Uint8Array;
      }[] = [];
      for (const { entry, effectiveRef, contentStored } of proceeding) {
        const record = buildEventRecord({
          ...(entry.input.type !== undefined ? { type: entry.input.type } : {}),
          subject: this.ctx.subject,
          contentHash: entry.contentHash,
          ...(entry.contentLength !== undefined ? { contentLength: entry.contentLength } : {}),
          ...(effectiveRef !== undefined ? { ref: effectiveRef } : {}),
          ...(entry.input.metadata !== undefined ? { metadata: entry.input.metadata } : {}),
        });
        const built = await buildEnvelope({
          record,
          signer: this.ctx.signer,
          environment: this.ctx.environment,
          // eventId was minted at add() (§eventId-at-add); pass it explicitly
          // so the envelope carries the same id the intent row was keyed under.
          eventId: entry.eventId,
          // Bind the content location into the SIGNED envelope. Only when a
          // logStore is configured, so the no-logStore path stays byte-identical.
          ...(this.ctx.logStore !== undefined && effectiveRef !== undefined
            ? { payloadRef: effectiveRef }
            : {}),
        });
        leaves.push({
          entry,
          effectiveRef,
          contentStored,
          envelope: built.envelope,
          envelopeBytes: built.envelopeBytes,
          recordBytes: built.recordBytes,
          leafHash: await leafHash(built.envelopeBytes),
        });
      }

      // 2. RFC 9162 tree + checkpoint record (chained per-batcher).
      const leafHashes = leaves.map((l) => l.leafHash);
      const root = await merkleRoot(leafHashes);
      const previousHash = (await this.ctx.store.getHead(this.chainKey)) ?? "GENESIS";

      const checkpointRecord = buildEventRecord({
        type: "checkpoint",
        subject: this.ctx.subject,
        chainKey: this.chainKey,
        previousHash,
        event: {
          merkle_root: bytesToHex(root),
          leaf_count: leaves.length,
          window: {
            start: new Date(windowStart).toISOString(),
            end: new Date(this.timers.now()).toISOString(),
          },
        },
      });
      const checkpoint = await buildEnvelope({
        record: checkpointRecord,
        signer: this.ctx.signer,
        environment: this.ctx.environment,
      });

      // 3. ONE upload per window. Head advances only after acceptance.
      const { txId } = await this.ctx.anchorCheckpointEnvelope(checkpoint.envelopeBytes);
      await this.ctx.store.setHead(this.chainKey, checkpoint.payloadHash);
      const gatewayUrl = `https://turbo-gateway.com/${txId}`;

      // 4. Retain the checkpoint row for this window, then per-event proof
      //    rows. Upload-then-sink: these run only after the tx was accepted.
      //    All writes are safe-wrapped (never throw), so a sink failure warns
      //    and never blocks receipt resolution below.
      await writeCheckpointSafely(this.ctx.sink, this.warn, {
        txId,
        envelope: checkpoint.envelope,
        recordBytes: checkpoint.recordBytes,
        merkleRoot: bytesToHex(root),
        gatewayUrl,
      });

      // 5. Retain each event's proof row, then resolve its receipt.
      for (let i = 0; i < leaves.length; i++) {
        const leaf = leaves[i]!;
        const path = await auditPath(i, leafHashes);
        const auditPathHex = path.map(bytesToHex);
        await writeEventSafely(this.ctx.sink, this.warn, {
          eventId: leaf.entry.eventId,
          contentHash: leaf.entry.contentHash,
          envelope: leaf.envelope,
          recordBytes: leaf.recordBytes,
          ...(leaf.effectiveRef !== undefined ? { ref: leaf.effectiveRef } : {}),
          ...(leaf.contentStored !== undefined ? { contentStored: leaf.contentStored } : {}),
          proof: {
            kind: "inclusion",
            leafHash: bytesToHex(leaf.leafHash),
            leafIndex: i,
            leafCount: leaves.length,
            auditPath: auditPathHex,
            checkpointTxId: txId,
          },
        });
        leaf.entry.resolve({
          checkpointTxId: txId,
          checkpointEnvelope: checkpoint.envelope,
          checkpointRecordBytes: checkpoint.recordBytes,
          gatewayUrl,
          root: bytesToHex(root),
          leafHash: bytesToHex(leaf.leafHash),
          leafIndex: i,
          leafCount: leaves.length,
          auditPath: auditPathHex,
          eventId: leaf.entry.eventId,
          contentHash: leaf.entry.contentHash,
          envelope: leaf.envelope,
          envelopeBytes: leaf.envelopeBytes,
          recordBytes: leaf.recordBytes,
          environment: this.ctx.environment,
          ...(leaf.contentStored !== undefined ? { contentStored: leaf.contentStored } : {}),
        });
      }
    } catch (err) {
      // The window's proofs are lost, the caller's data is not — every
      // event is re-anchorable. Each receipt rejects with the cause; the
      // flush itself resolves (see flush()).
      for (const entry of window) entry.reject(err);
    }
  }
}
