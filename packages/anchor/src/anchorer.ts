// createAnchorer() — the SDK entry point and the structural dev/prod gate
// (distribution.md §4.4, verbatim shape). Dev mode is zero-config: auto
// identity, auto-minted wallet, loud DEV-ONLY warning, environment:"dev"
// stamped inside the signed scope. Production THROWS without explicit
// signer + wallet + subject — unreachable on auto-generated secrets; the
// security boundary and the commercial boundary are the same line of code.

import { bytesToHex } from "@ar.io/proof";
import { sha256 } from "@noble/hashes/sha2";

import { Batcher, type Batch, type BatchOptions, type BatcherContext } from "./batch";
import { buildSignedDataItem, SolanaWalletSigner, txIdFromDataItem } from "./dataitem";
import type { DataItemSigner } from "./dataitem";
import { buildEnvelope } from "./envelope";
import { ProductionConfigError, TxIdMismatchError } from "./errors";
import { buildEventRecord } from "./record";
import { LocalEd25519Signer } from "./signer";
import { MemoryStore, type Store } from "./store";
import { buildTags } from "./tags";
import { TurboUploader, type TurboUploaderOptions, type Uploader } from "./turbo";
import type {
  Environment,
  EventsEnvelope,
  EventsSubject,
  Signer,
} from "./types";

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
  explorerUrl: string;
}

export interface Anchorer {
  readonly environment: Environment;
  anchor(input: AnchorInput): Promise<AnchorReceipt>;
  batch(options: BatchOptions): Batch;
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
  const uploader = options.uploader ?? new TurboUploader(options.turbo);

  async function anchor(input: AnchorInput): Promise<AnchorReceipt> {
    if ((input.data === undefined) === (input.contentHash === undefined)) {
      throw new Error("anchor: exactly one of data or contentHash is required");
    }
    const { contentHash, contentLength } =
      input.data !== undefined
        ? await hashContent(input.data)
        : { contentHash: requireSha256(input.contentHash!), contentLength: undefined };

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
      ...(input.ref !== undefined ? { ref: input.ref } : {}),
      ...(chainKey !== undefined ? { chainKey, previousHash: previousHash! } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    });

    const built = await buildEnvelope({
      record,
      signer,
      environment,
      ...(input.eventId !== undefined ? { eventId: input.eventId } : {}),
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

    return {
      txId,
      eventId: built.envelope.event_id,
      contentHash,
      payloadHash: built.payloadHash,
      envelope: built.envelope,
      envelopeBytes: built.envelopeBytes,
      recordBytes: built.recordBytes,
      environment,
      explorerUrl: `https://viewblock.io/arweave/tx/${txId}`,
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
      ...(options.timers !== undefined ? { timers: options.timers } : {}),
    });
    batches.push(b);
    return b;
  }

  return {
    environment,
    anchor,
    batch,
    publicKey: async () => bytesToHex(await signer.publicKey()),
    close: async () => {
      // Flush every batch this anchorer minted. Adapters call this
      // unconditionally on shutdown; single-shot use is a no-op.
      await Promise.all(batches.map((b) => b.close()));
    },
  };
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
