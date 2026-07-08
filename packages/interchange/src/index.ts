// @ar.io/anchor-interchange — anchor Interchange's audit trail as it commits.
//
// Interchange (https://github.com/faremeter/interchange) already keeps a
// signed, git-backed audit trail: every tool call becomes an AuditRecord
// committed to `state/audit/{sessionId}/{callId}.json` with an SSH-signed
// commit. This adapter decorates that store so each committed record ALSO
// lands on @ar.io/anchor's Merkle batcher: N records per session window
// become ONE Arweave write, and every record keeps its own standalone,
// offline-verifiable inclusion proof — evidence that exists outside the git
// repo it attests to, checkable by an auditor who trusts neither the agent
// nor its operator.
//
// The differentiator this adapter leans into is the SESSION CHAIN. Records
// arrive with Interchange's own reactor-owned `seq`; the adapter threads a
// per-session event chain (prev_event_id) through every hash-committed
// record — allowed calls, blocked calls, and errors alike. Drop a record
// and the next one's pointer dangles; reorder and `seq` disagrees; edit one
// and its hash breaks. Deletion-evident, reorder-evident, offline.
//
// Disclosure (ario.events/v1, Minimal): tool arguments and results go into
// the committed record, which is hashed locally and handed back to YOU via
// the receipt — the on-chain envelope carries only the hash. Nothing
// semantic ever leaves your process. `mapPayload` trims or redacts what the
// hash commits to before it is computed.
//
// No dependency on Interchange: the interfaces below are minimal structural
// (duck-typed) mirrors of `@intx/types` — any object with these shapes
// works, whatever version of Interchange produced it. See the README for
// why this is deliberate.

import type { Anchorer, Batch, BatchOptions, InclusionReceipt, Signer } from "@ar.io/anchor";

// The adapter's event_type vocabulary (profile §4: adapter-namespaced,
// additive-minor). Allowed calls, blocked calls, and runtime errors.
export const EVENT_TYPES = [
  "interchange.tool_call",
  "interchange.tool_blocked",
  "interchange.error",
] as const;

export type InterchangeEventType = (typeof EVENT_TYPES)[number];

// ---- structural mirrors of Interchange's shapes (no @intx dependency) ----

// @intx/crypto's Ed25519Crypto surface: raw 64-byte Ed25519 signatures,
// raw 32-byte public key, key held inside the instance.
export interface InterchangeCryptoProvider {
  sign(content: Uint8Array): Promise<Uint8Array>;
  getPublicKey(): Uint8Array;
}

// @intx/types/audit's AuditAuthz, loosened where narrowing adds nothing
// (`effect` is a string enum upstream; grants are opaque to this adapter).
export type InterchangeAuditAuthz = {
  effect: string | null;
  resolvedBy?: unknown;
  matchingGrants: unknown[];
  blocked: boolean;
  blockReason?: string;
};

// @intx/types/audit's AuditRecord: one completed (or blocked) tool call,
// correlated by Interchange's audit collector. `seq` is reactor-owned.
export type InterchangeAuditRecord = {
  callId: string;
  tool: string;
  arguments: Record<string, unknown>;
  authz: InterchangeAuditAuthz | null;
  result: { content: string | Record<string, unknown>; isError: boolean };
  timestamp: string;
  sessionId: string;
  seq: number;
};

// @intx/types/audit's ErrorRecord (`source` is 'inference' | 'reactor'
// upstream; kept open here).
export type InterchangeErrorRecord = {
  source: string;
  category: string;
  message: string;
  statusCode?: number;
  fatal: boolean;
  timestamp: string;
  sessionId: string;
  seq: number;
};

// @intx/types/runtime's AuditStore — the surface this adapter decorates.
export interface InterchangeAuditStore {
  commitAudit(records: InterchangeAuditRecord[], signal?: AbortSignal): Promise<void>;
  loadAudit(sessionId: string, signal?: AbortSignal): Promise<InterchangeAuditRecord[]>;
  commitErrors(records: InterchangeErrorRecord[], signal?: AbortSignal): Promise<void>;
}

// ---- the CryptoProvider → Signer adapter ---------------------------------

// Anchor with the agent's EXISTING Ed25519 identity key — the same key that
// SSH-signs Interchange's git commits — instead of minting a second
// anchoring identity to custody. Both interfaces are raw-Ed25519 over raw
// bytes, so the adapter is a pure shape change.
export function signerFromCryptoProvider(provider: InterchangeCryptoProvider): Signer {
  return {
    publicKey: async () => provider.getPublicKey(),
    sign: (bytes: Uint8Array) => provider.sign(bytes),
  };
}

// ---- the AuditStore decorator ---------------------------------------------

// What `mapPayload` sees for every record, before anything is committed.
export interface InterchangeAnchorEvent {
  type: InterchangeEventType;
  // The full audit/error record. Whatever this is after mapPayload runs is
  // JSON-serialized and hash-committed.
  payload: Record<string, unknown>;
  sessionId: string;
  callId: string | null; // null for error records
  tool: string | null; // null for error records
  seq: number; // Interchange's own reactor-owned sequence, passed through
  blocked: boolean;
  // Session-chain linkage the adapter computes (also committed, in metadata).
  prevEventId: string | null;
  eventId: string;
}

export interface AnchoredAuditStoreOptions {
  // Passed to anchorer.batch() per session; `name` is suffixed with the
  // session id so every session gets its OWN checkpoint chain (concurrent
  // sessions must not race on one chain head). Default: { maxEvents: 64,
  // flushOnIdle: 2000, name: "interchange" } — bursty agent sessions flush
  // shortly after the burst; a hard cap bounds the window.
  batch?: BatchOptions;
  // Trim/redact/transform the record before it is hash-committed (e.g.
  // strip `arguments` or `result.content` for sensitive tools). Return null
  // to skip anchoring the record entirely — the session chain stays gapless.
  mapPayload?: (event: InterchangeAnchorEvent) => Record<string, unknown> | null;
  // Where adapter-internal problems are reported (a record that fails to
  // JSON-serialize, a throwing mapPayload). Provenance must never crash the
  // agent; default console.warn.
  warn?: (message: string) => void;
  // Called with a session's resolved receipts whenever flushSession(id) or
  // close() completes — the hook for persisting receipts (e.g. into
  // `state/anchor/{sessionId}/` in the same git repo). Receipts are
  // CUMULATIVE per session (everything resolved so far), so keyed
  // persistence by event_id is naturally idempotent. The adapter itself
  // does no file I/O.
  onReceipts?: (sessionId: string, receipts: InclusionReceipt[]) => void;
}

const DEFAULT_BATCH: BatchOptions = { maxEvents: 64, flushOnIdle: 2_000 };
const DEFAULT_NAME = "interchange";

interface SessionState {
  batch: Batch;
  lastEventId: string | null;
  receipts: Promise<InclusionReceipt>[];
}

export class AnchoredAuditStore implements InterchangeAuditStore {
  readonly #inner: InterchangeAuditStore;
  readonly #anchorer: Anchorer;
  readonly #batchOptions: BatchOptions;
  readonly #mapPayload: AnchoredAuditStoreOptions["mapPayload"];
  readonly #warn: (message: string) => void;
  readonly #onReceipts: AnchoredAuditStoreOptions["onReceipts"];
  // sessionId -> lazily created batch + chain state + receipt promises.
  readonly #sessions = new Map<string, SessionState>();

  constructor(
    inner: InterchangeAuditStore,
    anchorer: Anchorer,
    options: AnchoredAuditStoreOptions = {},
  ) {
    this.#inner = inner;
    this.#anchorer = anchorer;
    this.#batchOptions = options.batch ?? DEFAULT_BATCH;
    this.#mapPayload = options.mapPayload;
    this.#warn = options.warn ?? ((m) => console.warn(`[ario-anchor-interchange] ${m}`));
    this.#onReceipts = options.onReceipts;
  }

  // ---- the decorated AuditStore surface ----------------------------------

  // Git stays the system of record: delegate FIRST, and if the inner store
  // throws, anchor nothing — never attest to a record that was not
  // persisted. Each anchored record is one in-memory batch.add(); signing
  // and the single upload happen at window flush, off the hot path.
  async commitAudit(records: InterchangeAuditRecord[], signal?: AbortSignal): Promise<void> {
    await this.#inner.commitAudit(records, signal);
    for (const record of records) this.#anchorAudit(record);
  }

  async loadAudit(sessionId: string, signal?: AbortSignal): Promise<InterchangeAuditRecord[]> {
    return this.#inner.loadAudit(sessionId, signal);
  }

  async commitErrors(records: InterchangeErrorRecord[], signal?: AbortSignal): Promise<void> {
    await this.#inner.commitErrors(records, signal);
    for (const record of records) this.#anchorError(record);
  }

  // ---- lifecycle: explicit, no hidden exit hooks --------------------------

  // Force the session's window to flush now and resolve every receipt for
  // the session so far. Long-lived hosts call this at checkpoint
  // boundaries; the session's batch stays open for further records.
  async flushSession(sessionId: string): Promise<InclusionReceipt[]> {
    const session = this.#sessions.get(sessionId);
    if (!session) return [];
    await session.batch.flush();
    const receipts = await Promise.all(session.receipts);
    this.#onReceipts?.(sessionId, receipts);
    return receipts;
  }

  // Flush every session, refuse further anchoring on their batches, and
  // resolve all receipts. Call at the end of the process — receipts carry
  // everything anchorer.bundle() needs for the auditor handoff.
  async close(): Promise<Map<string, InclusionReceipt[]>> {
    const bySession = new Map<string, InclusionReceipt[]>();
    for (const [sessionId, session] of this.#sessions) {
      await session.batch.close();
      const receipts = await Promise.all(session.receipts);
      this.#onReceipts?.(sessionId, receipts);
      bySession.set(sessionId, receipts);
    }
    return bySession;
  }

  // Anchor already-persisted audit records WITHOUT delegating — for hosts
  // that hook AuditCollector.flush() instead of the store. Same batches,
  // same session chains.
  anchorAudits(records: InterchangeAuditRecord[]): void {
    for (const record of records) this.#anchorAudit(record);
  }

  // ---- internals ----------------------------------------------------------

  #anchorAudit(record: InterchangeAuditRecord): void {
    const blocked = record.authz?.blocked === true;
    this.#anchor(blocked ? "interchange.tool_blocked" : "interchange.tool_call", record, {
      sessionId: record.sessionId,
      callId: record.callId,
      tool: record.tool,
      seq: record.seq,
      blocked,
    });
  }

  #anchorError(record: InterchangeErrorRecord): void {
    this.#anchor("interchange.error", record, {
      sessionId: record.sessionId,
      callId: null,
      tool: null,
      seq: record.seq,
      blocked: false,
    });
  }

  #anchor(
    type: InterchangeEventType,
    record: InterchangeAuditRecord | InterchangeErrorRecord,
    info: {
      sessionId: string;
      callId: string | null;
      tool: string | null;
      seq: number;
      blocked: boolean;
    },
  ): void {
    try {
      const session = this.#session(info.sessionId);
      const eventId = globalThis.crypto.randomUUID();

      const event: InterchangeAnchorEvent = {
        type,
        payload: record,
        sessionId: info.sessionId,
        callId: info.callId,
        tool: info.tool,
        seq: info.seq,
        blocked: info.blocked,
        prevEventId: session.lastEventId,
        eventId,
      };

      let committed: Record<string, unknown> | null = event.payload;
      if (this.#mapPayload) committed = this.#mapPayload(event);
      if (committed === null) return; // caller opted this record out

      const handle = session.batch.add({
        type,
        data: JSON.stringify(committed),
        eventId,
        metadata: {
          interchange: {
            session_id: info.sessionId,
            call_id: info.callId,
            seq: info.seq,
            tool: info.tool,
            blocked: info.blocked,
            prev_event_id: session.lastEventId,
          },
        },
      });

      // Only advance the chain for records that were actually committed —
      // skipped records leave no dangling pointer.
      session.lastEventId = eventId;
      session.receipts.push(handle.receipt());
    } catch (err) {
      // Provenance must never take the agent down with it.
      this.#warn(`${type} not anchored: ${errorMessage(err)}`);
    }
  }

  #session(sessionId: string): SessionState {
    let session = this.#sessions.get(sessionId);
    if (!session) {
      const base = this.#batchOptions.name ?? DEFAULT_NAME;
      session = {
        batch: this.#anchorer.batch({ ...this.#batchOptions, name: `${base}:${sessionId}` }),
        lastEventId: null,
        receipts: [],
      };
      this.#sessions.set(sessionId, session);
    }
    return session;
  }
}

// The one-line entry point:
//
//   const store = anchoredAuditStore(gitStore, createAnchorer({ signer }));
//   // ... hand `store` to Interchange wherever an AuditStore goes ...
//   const receipts = await store.close();
export function anchoredAuditStore(
  inner: InterchangeAuditStore,
  anchorer: Anchorer,
  options?: AnchoredAuditStoreOptions,
): AnchoredAuditStore {
  return new AnchoredAuditStore(inner, anchorer, options);
}

// Convenience for hosts that hook the collector instead of the store:
//
//   anchorRecordsFromCollector(store, collector.flush());
export function anchorRecordsFromCollector(
  store: AnchoredAuditStore,
  records: InterchangeAuditRecord[],
): void {
  store.anchorAudits(records);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
