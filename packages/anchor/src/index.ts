// @ar.io/anchor — TypeScript write path of the ar.io verification stack.
//
// Builds signed Verifiable Event Envelopes under the ario.events/v1 profile
// (envelope-spec v1.1, Minimal disclosure), assembles ANS-104 data items,
// uploads via Turbo, and Merkle-batches high-frequency events with per-event
// inclusion proofs. The verify side is the separate read-only @ar.io/proof —
// this package consumes its primitives and never re-implements verification.

export { PROFILE_SPEC_VERSION } from "./profile.js";
export { createAnchorer } from "./anchorer.js";
export type {
  AnchorInput,
  AnchorReceipt,
  Anchorer,
  AnchorerOptions,
  ApiGuardConfig,
  BundleOptions,
} from "./anchorer.js";
export { Batcher } from "./batch.js";
export type {
  AddHandle,
  Batch,
  BatchEventInput,
  BatchOptions,
  InclusionReceipt,
} from "./batch.js";
export {
  ANCHOR_TRACE_BODY_TYPE,
  EVIDENCE_SIGNATURE_ALG,
  EVIDENCE_SPEC_VERSION,
  toEvidenceBundle,
} from "./evidence.js";
export type {
  AnchorTraceBody,
  EvidenceBundle,
  EvidenceIssuer,
  EvidenceVerdict,
  ToEvidenceBundleOptions,
  TraceCheckpointBody,
  TraceEventBody,
  TraceInclusionBody,
} from "./evidence.js";
export { buildEventRecord, isValidEventType } from "./record.js";
export { buildEnvelope } from "./envelope.js";
export { LocalEd25519Signer } from "./signer.js";
export {
  SIGNATURE_TYPE_ARWEAVE,
  SIGNATURE_TYPE_SOLANA,
  SolanaWalletSigner,
  buildSignedDataItem,
  dataItemDeepHash,
  txIdFromDataItem,
} from "./dataitem.js";
export type { DataItemSigner } from "./dataitem.js";
export { deepHashChunk, deepHashList } from "./deephash.js";
export { encodeAvroTags } from "./avro.js";
export type { Tag } from "./avro.js";
export { buildTags } from "./tags.js";
export type { TagOptions } from "./tags.js";
export { MemoryStore } from "./store.js";
export type { PendingLeaf, Store } from "./store.js";
export { DEFAULT_TURBO_UPLOAD_URL, TurboUploader } from "./turbo.js";
export type { TurboUploaderOptions, UploadReceipt, Uploader } from "./turbo.js";
export {
  AnchorError,
  FundingExhaustedError,
  ProductionConfigError,
  TxIdMismatchError,
  UploadFailedError,
  UploadRejectedError,
} from "./errors.js";
export type { AnchorErrorCode } from "./errors.js";
export type {
  BuildEnvelopeInput,
  BuildRecordInput,
  BuiltEnvelope,
  Environment,
  EventRecord,
  EventsEnvelope,
  EventsSubject,
  Signer,
} from "./types.js";
