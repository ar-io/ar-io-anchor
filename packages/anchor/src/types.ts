// Shared types for the ario.events/v1 write path. The wire/byte semantics
// these types serialize into are pinned by docs/profile-ario.events-v1.md and
// the family contract (ar-io-proof specs/envelope-spec.md v1.1).

// The PRD's signing plug point: key custody stays behind this interface (file,
// raw seed, Vault, KMS adapters all implement it) — core code never requires
// raw key bytes. sign() receives the exact envelope-for-signing JCS bytes and
// must return a 64-byte Ed25519 signature.
export interface Signer {
  publicKey(): Promise<Uint8Array>;
  sign(bytes: Uint8Array): Promise<Uint8Array>;
}

export type Environment = "dev" | "production";

// Producer identity context carried in the event record core (Minimal mode —
// never on-chain). Load-bearing identity is always the envelope's public_key.
export interface EventsSubject {
  type: "producer";
  producer_id?: string;
  name?: string;
}

// The hash-committed payload (profile §3): caller retains its canonical bytes;
// only SHA-256(JCS(record)) goes on-chain.
export interface EventRecord {
  payload_version: 1;
  spec_version: string;
  event_type: string;
  subject: EventsSubject;
  previous_hash: string;
  event: Record<string, unknown>;
  context: Record<string, unknown>;
  metadata: Record<string, unknown>;
  extras: Record<string, unknown>;
}

// The on-chain envelope (profile §2): exactly the family skeleton plus the
// optional payload_ref locator. No disclosure fields — Minimal mode.
export interface EventsEnvelope {
  spec_version: string;
  event_id: string;
  payload_hash: string;
  signed_at: string;
  environment: Environment;
  public_key: string;
  signature: string;
  payload_ref?: string;
}

export interface BuildRecordInput {
  // event_type per profile §4 grammar. Defaults to the reserved "event".
  type?: string;
  subject: EventsSubject;
  // SHA-256 hex of the caller's raw bytes. Required for "event"-shaped types;
  // checkpoint records carry merkle fields in `event` instead.
  contentHash?: string;
  contentLength?: number;
  ref?: string;
  // Chain selection: name + resolved head. Both present or both absent.
  chainKey?: string;
  previousHash?: string;
  metadata?: Record<string, unknown>;
  // Profile-internal: event section override for reserved types (checkpoint).
  event?: Record<string, unknown>;
}

export interface BuildEnvelopeInput {
  record: EventRecord;
  signer: Signer;
  environment: Environment;
  payloadRef?: string;
  // Injectable for idempotency (PRD eventId) and deterministic tests.
  eventId?: string;
  signedAt?: string;
}

export interface BuiltEnvelope {
  envelope: EventsEnvelope;
  // JCS-canonical bytes of the COMPLETE envelope — exactly what gets uploaded
  // (family invariant 1: producers MUST upload the canonical bytes).
  envelopeBytes: Uint8Array;
  // JCS-canonical bytes of the event record — what the caller must retain for
  // semantic verification (external commitment).
  recordBytes: Uint8Array;
  payloadHash: string;
}
