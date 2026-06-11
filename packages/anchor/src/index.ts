// @ar.io/anchor — TypeScript write path of the ar.io verification stack.
//
// Builds signed Verifiable Event Envelopes under the ario.events/v1 profile
// (envelope-spec v1.1, Minimal disclosure), assembles ANS-104 data items,
// uploads via Turbo, and Merkle-batches high-frequency events with per-event
// inclusion proofs. The verify side is the separate read-only @ar.io/proof —
// this package consumes its primitives and never re-implements verification.

export { PROFILE_SPEC_VERSION } from "./profile";
export { createAnchorer } from "./anchorer";
export type {
  AnchorInput,
  AnchorReceipt,
  Anchorer,
  AnchorerOptions,
  ApiGuardConfig,
} from "./anchorer";
export { buildEventRecord, isValidEventType } from "./record";
export { buildEnvelope } from "./envelope";
export { LocalEd25519Signer } from "./signer";
export {
  SIGNATURE_TYPE_ARWEAVE,
  SIGNATURE_TYPE_SOLANA,
  SolanaWalletSigner,
  buildSignedDataItem,
  dataItemDeepHash,
  txIdFromDataItem,
} from "./dataitem";
export type { DataItemSigner } from "./dataitem";
export { deepHashChunk, deepHashList } from "./deephash";
export { encodeAvroTags } from "./avro";
export type { Tag } from "./avro";
export { buildTags } from "./tags";
export type { TagOptions } from "./tags";
export { MemoryStore } from "./store";
export type { PendingLeaf, Store } from "./store";
export { DEFAULT_TURBO_UPLOAD_URL, TurboUploader } from "./turbo";
export type { TurboUploaderOptions, UploadReceipt, Uploader } from "./turbo";
export {
  AnchorError,
  FundingExhaustedError,
  ProductionConfigError,
  TxIdMismatchError,
  UploadFailedError,
  UploadRejectedError,
} from "./errors";
export type { AnchorErrorCode } from "./errors";
export type {
  BuildEnvelopeInput,
  BuildRecordInput,
  BuiltEnvelope,
  Environment,
  EventRecord,
  EventsEnvelope,
  EventsSubject,
  Signer,
} from "./types";
