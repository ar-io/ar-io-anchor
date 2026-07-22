// createAnchorer() — the SDK entry point and the structural dev/prod gate
// (distribution.md §4.4, verbatim shape). Dev mode is zero-config: auto
// identity, auto-minted wallet, loud DEV-ONLY warning, environment:"dev"
// stamped inside the signed scope. Production THROWS without explicit
// signer + wallet + subject — unreachable on auto-generated secrets; the
// security boundary and the commercial boundary are the same line of code.

import { bytesToHex } from "@ar.io/proof";
import { sha256 } from "@noble/hashes/sha2";

import { Batcher, type Batch, type BatchOptions, type BatcherContext, type InclusionReceipt } from "./batch.js";
import { buildSignedDataItem, SolanaWalletSigner, txIdFromDataItem } from "./dataitem.js";
import type { DataItemSigner } from "./dataitem.js";
import { buildEnvelope } from "./envelope.js";
import { ProductionConfigError, RetentionError, TxIdMismatchError } from "./errors.js";
import {
  toEvidenceBundle,
  type EvidenceBundle,
  type EvidenceIssuer,
} from "./evidence.js";
import {
  DEFAULT_RETENTION_MODE,
  retentionWarnMessage,
  runPut,
  type LogStore,
  type RetentionErrorMode,
} from "./logstore.js";
import { buildEventRecord } from "./record.js";
import { LocalEd25519Signer } from "./signer.js";
import { type Sink, writeEventSafely } from "./sink.js";
import { MemoryStore, type Store } from "./store.js";
import { buildTags } from "./tags.js";
import { TurboUploader, type TurboUploaderOptions, type Uploader } from "./turbo.js";
import type {
  Environment,
  EventsEnvelope,
  EventsSubject,
  Signer,
} from "./types.js";

export interface ApiGuardConfig {
  // Breadcrumb (PRD step ⑥ / Wave 3 paired api-guard lane): production-mode
  // public-key registration via the producer:enroll flavor of the existing
  // agent enrollment flow. Accepted now so production configs are
  // forward-compatible; the registration call lands with that lane.
  baseUrl: string;
  apiKey: string;
}

export interface AnchorerOptions {
  environment?: Environment;
  signer?: Signer;
  wallet?: DataItemSigner;
  subject?: EventsSubject;
  apiGuard?: ApiGuardConfig;
  // Plumbing (all optional, test-injectable).
  uploader?: Uploader;
  store?: Store;
  // Proof retention (T9 Phase 1). Injected below the adapter seam and threaded
  // through BatcherContext like `store`, so every adapter inherits durable
  // proofs. Absent → byte-identical to today.
  sink?: Sink;
  // Content retention (T9 Phase 2). Same injection path as `sink`: the exact
  // committed bytes are handed to logStore.put() at add()/anchor(). Absent →
  // byte-identical to today (raw bytes never leave the process).
  logStore?: LogStore;
  // Retention ordering when a logStore is configured. Default "skip-anchor"
  // (strict, BDFL-ratified): store-before-anchor; a put() failure fails the
  // event loudly but enumerably and does NOT anchor it. "anchor-anyway-flag"
  // is best-effort (anchor with contentStored:false on put failure). Ignored
  // when no logStore is configured.
  onRetentionError?: RetentionErrorMode;
  turbo?: TurboUploaderOptions;
  // Profile §7 tag options: opaque enumeration scope; Content-Hash tag is a
  // DISCLOSURE and stays off unless explicitly enabled.
  scopeNamespace?: string;
  publishContentHashTag?: boolean;
  warn?: (message: string) => void;
  // Test seam (seam 7, fake clock for the batcher). Defaults to real timers.
  timers?: BatcherContext["timers"];
}

export interface AnchorInput {
  type?: string;
  data?: Uint8Array | string | AsyncIterable<Uint8Array>;
  contentHash?: string;
  ref?: string;
  metadata?: Record<string, unknown>;
  chain?: string;
  eventId?: string;
}

export interface AnchorReceipt {
  txId: string;
  eventId: string;
  contentHash: string;
  payloadHash: string;
  envelope: EventsEnvelope;
  envelopeBytes: Uint8Array;
  // The caller's retention obligation (external commitment): the canonical
  // event-record bytes that payload_hash commits to.
  recordBytes: Uint8Array;
  environment: Environment;
  gatewayUrl: string;
  // Content retention (T9 Phase 2). Present ONLY when a logStore is configured:
  // true when the committed bytes were durably stored, false when best-effort
  // mode anchored despite a put() failure (onRetentionError:
  // "anchor-anyway-flag"). Omitted entirely when no logStore is configured, so
  // receipts are byte-identical to today. Strict-mode put failures never reach
  // a receipt — they throw RetentionError instead.
  contentStored?: boolean;
}

// Override the defaults bundle() applies for you. Everything is optional —
// the zero-arg call is the intended path.
export interface BundleOptions {
  // Identity context on the wrapper. Defaults to { kind: "producer" } (plus
  // the subject's producer_id when this anchorer was configured with one).
  issuer?: EvidenceIssuer;
  // The named delivery surface. Defaults to the receipts' gateway.
  gateway?: string | null;
  // Opt-in raw-byte disclosure — embeds each event's raw bytes inside the
  // signed body so the bundle is one self-contained, verify-anywhere file.
  // Default off. Pass a map keyed by eventId to disclose specific bytes, or
  // `true` to auto-disclose from this anchorer's configured logStore: every
  // receipt whose bytes the store retained is embedded; hash-only adds (no
  // stored copy exists anywhere) are skipped. `true` without a retrieving
  // logStore throws — silent no-disclosure would misrepresent intent.
  disclose?: true | Record<string, Uint8Array | string>;
}

export interface Anchorer {
  readonly environment: Environment;
  anchor(input: AnchorInput): Promise<AnchorReceipt>;
  batch(options: BatchOptions): Batch;
  // Serialize a set of inclusion receipts into ONE signed, portable
  // ario.evidence/v1 / ario.anchor.trace/v1 bundle — signed with THIS
  // anchorer's own key (the same key the receipts' envelopes carry), so the
  // call site needs zero signer handling. The explicit/advanced form is the
  // standalone toEvidenceBundle(receipts, { signer, ... }).
  bundle(receipts: InclusionReceipt[], options?: BundleOptions): Promise<EvidenceBundle>;
  publicKey(): Promise<string>;
  close(): Promise<void>;
}

export function createAnchorer(options: AnchorerOptions = {}): Anchorer {
  const environment = options.environment ?? "dev";

  if (environment === "production") {
    const missing: string[] = [];
    if (!options.signer) missing.push("signer");
    if (!options.wallet) missing.push("wallet");
    if (!options.subject) missing.push("subject");
    if (missing.length > 0) throw new ProductionConfigError(missing);
  }

  const warn = options.warn ?? ((m: string) => console.warn(m));
  if (environment === "dev" && (!options.signer || !options.wallet)) {
    warn(
      "[@ar.io/anchor] DEV MODE: auto-generated identity and wallet. Proofs are " +
        'permanently marked environment:"dev" inside the signed bytes and can never be ' +
        "presented as production evidence. Not for production use.",
    );
  }

  const signer = options.signer ?? LocalEd25519Signer.generate();
  const wallet = options.wallet ?? new SolanaWalletSigner(LocalEd25519Signer.generate());
  const subject = options.subject ?? { type: "producer" };
  const store = options.store ?? new MemoryStore();
  // No default sink — absence means retention is off (byte-identical to today).
  const sink = options.sink;
  // No default logStore — absence means content retention is off (byte-
  // identical to today; raw bytes never leave the process). Strict is the
  // default ordering once a logStore IS configured.
  const logStore = options.logStore;
  const retentionMode = options.onRetentionError ?? DEFAULT_RETENTION_MODE;
  const uploader = options.uploader ?? new TurboUploader(options.turbo);

  async function anchor(input: AnchorInput): Promise<AnchorReceipt> {
    if ((input.data === undefined) === (input.contentHash === undefined)) {
      throw new Error("anchor: exactly one of data or contentHash is required");
    }
    const { contentHash, contentLength } =
      input.data !== undefined
        ? await hashContent(input.data)
        : { contentHash: requireSha256(input.contentHash!), contentLength: undefined };

    // Content retention (T9 Phase 2), strict order: content-store → anchor →
    // proof. Only concrete in-memory bytes are retainable — an AsyncIterable
    // streams through the hasher without buffering (respecting the no-buffer
    // design), so it carries no stored copy. When no logStore is configured
    // this whole block is inert and the path below is byte-identical to today.
    const eventId =
      input.eventId ?? (logStore !== undefined ? crypto.randomUUID() : undefined);
    const contentBytes =
      typeof input.data === "string"
        ? new TextEncoder().encode(input.data)
        : input.data instanceof Uint8Array
          ? input.data
          : undefined;

    let putRef: string | undefined;
    let contentStored: boolean | undefined;
    if (logStore !== undefined && contentBytes !== undefined) {
      const res = await runPut(logStore, {
        eventId: eventId!,
        contentHash,
        content: contentBytes,
        ...(input.ref !== undefined ? { ref: input.ref } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      });
      if (res.ok) {
        contentStored = true;
        putRef = res.ref;
      } else if (retentionMode === "skip-anchor") {
        // Strict: do NOT anchor an event whose content did not store. Loud.
        throw new RetentionError(eventId!, res.error);
      } else {
        // Best-effort: anchor anyway, flagged enumerable via contentStored:false.
        contentStored = false;
        warn(retentionWarnMessage(eventId!, res.error));
      }
    }

    // payload_ref / ref binding: caller-supplied ref WINS; the logStore's
    // content-addressed ref fills only when the caller left it empty. This ref
    // is a producer-ASSERTED locator, never a trust signal — a verifier fetches
    // whatever is at it and re-hashes against content_hash (envelope-spec §2:
    // "a lying locator is caught by the hash, never trusted on its own"), so
    // signing a caller ref the SDK did not itself store is by-design (external-
    // commitment). It is orthogonal to `contentStored` (see RetainedEvent):
    // contentStored reports whether the SDK's logStore kept a byte-exact copy,
    // which may live at a DIFFERENT location than a caller-supplied payload_ref.
    const effectiveRef = input.ref ?? putRef;

    // Chain head resolves from the store; GENESIS for a chain's first link.
    let chainKey: string | undefined;
    let previousHash: string | undefined;
    if (input.chain !== undefined) {
      chainKey = input.chain;
      previousHash = (await store.getHead(chainKey)) ?? "GENESIS";
    }

    const record = buildEventRecord({
      ...(input.type !== undefined ? { type: input.type } : {}),
      subject,
      contentHash,
      ...(contentLength !== undefined ? { contentLength } : {}),
      ...(effectiveRef !== undefined ? { ref: effectiveRef } : {}),
      ...(chainKey !== undefined ? { chainKey, previousHash: previousHash! } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    });

    const built = await buildEnvelope({
      record,
      signer,
      environment,
      ...(eventId !== undefined ? { eventId } : {}),
      // Bind the content location into the SIGNED envelope. Only when a
      // logStore is configured, so the no-logStore path stays byte-identical.
      ...(logStore !== undefined && effectiveRef !== undefined
        ? { payloadRef: effectiveRef }
        : {}),
    });

    const { txId } = await anchorEnvelopeBytes(
      built.envelopeBytes,
      options.publishContentHashTag ? contentHash : undefined,
    );

    // Head advances only after Turbo accepted — a failed upload never
    // burns a chain link.
    if (chainKey !== undefined) {
      await store.setHead(chainKey, built.payloadHash);
    }

    const gatewayUrl = `https://turbo-gateway.com/${txId}`;

    // Upload-then-sink: the proof row is only ever written for the accepted tx
    // (the TxIdMismatch check is upstream, in anchorEnvelopeBytes). A sink
    // failure warns and degrades to today's in-memory-only receipt.
    await writeEventSafely(sink, warn, {
      eventId: built.envelope.event_id,
      contentHash,
      envelope: built.envelope,
      recordBytes: built.recordBytes,
      ...(effectiveRef !== undefined ? { ref: effectiveRef } : {}),
      ...(contentStored !== undefined ? { contentStored } : {}),
      proof: { kind: "direct", txId, gatewayUrl },
    });

    return {
      txId,
      eventId: built.envelope.event_id,
      contentHash,
      payloadHash: built.payloadHash,
      envelope: built.envelope,
      envelopeBytes: built.envelopeBytes,
      recordBytes: built.recordBytes,
      environment,
      gatewayUrl,
      ...(contentStored !== undefined ? { contentStored } : {}),
    };
  }

  // One upload path for everything: checkpoint envelopes ride the same
  // tag/dataitem/predict/upload/divergence pipeline as single-shot anchors.
  // The Content-Hash tag (a disclosure, opt-in) only ever applies to
  // single-shot events; checkpoints pass no contentHash.
  async function anchorEnvelopeBytes(
    envelopeBytes: Uint8Array,
    contentHash?: string,
  ): Promise<{ txId: string }> {
    const tags = await buildTags({
      environment,
      ...(options.scopeNamespace !== undefined
        ? { scopeNamespace: options.scopeNamespace }
        : {}),
      ...(contentHash !== undefined ? { contentHash } : {}),
    });
    const dataItem = await buildSignedDataItem(wallet, envelopeBytes, tags);
    const predictedTxId = await txIdFromDataItem(dataItem);
    const receipt = await uploader.upload(dataItem);
    if (receipt.txId !== predictedTxId) {
      throw new TxIdMismatchError(predictedTxId, receipt.txId);
    }
    return { txId: receipt.txId };
  }

  const batches: Batch[] = [];

  function batch(batchOptions: BatchOptions): Batch {
    const b = new Batcher(batchOptions, {
      signer,
      subject,
      environment,
      store,
      anchorCheckpointEnvelope: anchorEnvelopeBytes,
      warn,
      ...(sink !== undefined ? { sink } : {}),
      ...(logStore !== undefined ? { logStore, onRetentionError: retentionMode } : {}),
      ...(options.timers !== undefined ? { timers: options.timers } : {}),
    });
    batches.push(b);
    return b;
  }

  async function bundle(
    receipts: InclusionReceipt[],
    bundleOptions: BundleOptions = {},
  ): Promise<EvidenceBundle> {
    // disclose: true — resolve the map from the configured logStore (the
    // export path content retention exists for). Only retained bytes are
    // embedded: a hash-only add has no stored copy anywhere, so it stays
    // hash-only in the bundle too. toEvidenceBundle still asserts every
    // resolved byte-string against its committed content_hash before signing.
    let disclose = bundleOptions.disclose;
    if (disclose === true) {
      if (logStore?.get === undefined) {
        throw new Error(
          "anchor: bundle({ disclose: true }) needs a logStore with get() — " +
            "configure createAnchorer({ logStore }) or pass an explicit disclose map",
        );
      }
      const resolved: Record<string, Uint8Array> = {};
      for (const r of receipts) {
        const bytes = await logStore.get(r.eventId);
        if (bytes !== null) resolved[r.eventId] = bytes;
      }
      disclose = resolved;
    }

    // Sign the wrapper with the anchorer's OWN signer (caller-supplied or
    // auto-generated in dev mode) — the same key the receipts' envelopes are
    // signed with. Default issuer derives from the anchorer's subject (a bare
    // { kind: "producer" }, plus producer_id when configured); the caller may
    // override issuer/gateway.
    return toEvidenceBundle(receipts, {
      signer,
      issuer: bundleOptions.issuer ?? defaultIssuer(subject),
      ...(bundleOptions.gateway !== undefined ? { gateway: bundleOptions.gateway } : {}),
      ...(disclose !== undefined ? { disclose } : {}),
    });
  }

  return {
    environment,
    anchor,
    batch,
    bundle,
    publicKey: async () => bytesToHex(await signer.publicKey()),
    close: async () => {
      // Flush every batch this anchorer minted. Adapters call this
      // unconditionally on shutdown; single-shot use is a no-op.
      await Promise.all(batches.map((b) => b.close()));
    },
  };
}

// The wrapper's default issuer mirrors evidence.ts's issuerFromSubject: a bare
// { kind: "producer" }, carrying the configured producer_id when present. Kept
// minimal — the load-bearing identity is always the wrapper's public_key.
function defaultIssuer(subject: EventsSubject): EvidenceIssuer {
  const issuer: EvidenceIssuer = { kind: "producer" };
  if (subject.producer_id !== undefined) issuer.producer_id = subject.producer_id;
  return issuer;
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

function requireSha256(hash: string): string {
  if (!SHA256_HEX_RE.test(hash)) {
    throw new Error("anchor: contentHash must be lowercase sha256 hex");
  }
  return hash;
}

// Hash locally, never upload raw bytes. Strings hash as UTF-8; async
// iterables stream through an incremental hasher without buffering.
async function hashContent(
  data: Uint8Array | string | AsyncIterable<Uint8Array>,
): Promise<{ contentHash: string; contentLength: number }> {
  if (typeof data === "string") {
    const bytes = new TextEncoder().encode(data);
    return { contentHash: bytesToHex(sha256(bytes)), contentLength: bytes.length };
  }
  if (data instanceof Uint8Array) {
    return { contentHash: bytesToHex(sha256(data)), contentLength: data.length };
  }
  const hasher = sha256.create();
  let length = 0;
  for await (const chunk of data) {
    hasher.update(chunk);
    length += chunk.length;
  }
  return { contentHash: bytesToHex(hasher.digest()), contentLength: length };
}
