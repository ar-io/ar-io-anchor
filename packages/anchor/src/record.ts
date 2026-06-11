// Event-record assembly (profile §3): the hash-committed payload of an
// ario.events/v1 envelope. Minimal disclosure means the disclosure fields
// (event_type, subject, previous_hash) live HERE, in the record core — never
// in the on-chain envelope.

import { PROFILE_SPEC_VERSION } from "./profile";
import type { BuildRecordInput, EventRecord, EventsSubject } from "./types";

// Profile §4 grammar: lowercase snake segments, dot-namespaced, ≤64 chars.
const EVENT_TYPE_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const MAX_EVENT_TYPE_LEN = 64;

// Reserved single-segment types. Other unnamespaced names are reserved for
// future profile use — adapters and callers MUST namespace (profile §4).
const RESERVED_TYPES = new Set(["event", "checkpoint"]);

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

// Family §2 subject grammar: string fields ≤128 chars, constrained charset.
const SUBJECT_FIELD_RE = /^[A-Za-z0-9_.:-]+$/;
const MAX_SUBJECT_FIELD_LEN = 128;

export function isValidEventType(type: string): boolean {
  return type.length > 0 && type.length <= MAX_EVENT_TYPE_LEN && EVENT_TYPE_RE.test(type);
}

function validateSubject(subject: EventsSubject): void {
  if (subject.type !== "producer") {
    throw new Error(`subject.type must be "producer", got ${JSON.stringify(subject.type)}`);
  }
  for (const [field, value] of Object.entries(subject)) {
    if (typeof value !== "string") {
      throw new Error(`subject.${field} must be a string`);
    }
    if (value.length > MAX_SUBJECT_FIELD_LEN || !SUBJECT_FIELD_RE.test(value)) {
      throw new Error(
        `subject.${field} must be ≤${MAX_SUBJECT_FIELD_LEN} chars matching ${SUBJECT_FIELD_RE}`,
      );
    }
  }
}

export function buildEventRecord(input: BuildRecordInput): EventRecord {
  const type = input.type ?? "event";
  if (!isValidEventType(type)) {
    throw new Error(`invalid event_type ${JSON.stringify(type)} (profile §4 grammar)`);
  }
  if (!type.includes(".") && !RESERVED_TYPES.has(type)) {
    throw new Error(
      `event_type ${JSON.stringify(type)}: single-segment names are profile-reserved — adapters must namespace (e.g. "myapp.${type}")`,
    );
  }

  validateSubject(input.subject);

  // Chain selection is all-or-nothing: a chain key names the chain, the
  // previous hash is its resolved head (the anchorer resolves heads via its
  // Store; "GENESIS" is a valid resolved head for a chain's first link).
  if ((input.chainKey === undefined) !== (input.previousHash === undefined)) {
    throw new Error("chainKey and previousHash must be supplied together (or neither)");
  }
  const previousHash = input.previousHash ?? "GENESIS";
  if (previousHash !== "GENESIS" && !SHA256_HEX_RE.test(previousHash)) {
    throw new Error('previous_hash must be lowercase sha256 hex or "GENESIS"');
  }

  const event: Record<string, unknown> = input.event ? { ...input.event } : {};
  if (type !== "checkpoint" && input.event === undefined) {
    // Event-shaped types commit to caller content.
    if (input.contentHash === undefined) {
      throw new Error(`event_type ${JSON.stringify(type)} requires content_hash`);
    }
    if (!SHA256_HEX_RE.test(input.contentHash)) {
      throw new Error("content_hash must be lowercase sha256 hex");
    }
    event.content_hash = input.contentHash;
    if (input.contentLength !== undefined) {
      if (!Number.isInteger(input.contentLength) || input.contentLength < 0) {
        throw new Error("content_length must be a non-negative integer");
      }
      event.content_length = input.contentLength;
    }
    if (input.ref !== undefined) event.ref = input.ref;
  }

  const context: Record<string, unknown> = {};
  if (input.chainKey !== undefined) context.chain_key = input.chainKey;

  return {
    payload_version: 1,
    spec_version: PROFILE_SPEC_VERSION,
    event_type: type,
    subject: { ...input.subject },
    previous_hash: previousHash,
    event,
    context,
    metadata: input.metadata ? { ...input.metadata } : {},
    extras: {},
  };
}
