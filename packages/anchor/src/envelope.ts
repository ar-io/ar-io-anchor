// Envelope assembly (profile §2): event record → payload_hash → signed
// Minimal-mode envelope. Consumes @ar.io/proof's primitives (JCS, SHA-256) —
// the kernel is the single source of canonicalization truth; this module
// only adds the write-side ordering: hash the record, assemble the skeleton,
// sign JCS(envelope_without_signature_and_without_co_signatures), then emit
// the canonical bytes of the complete envelope for upload.

import { bytesToHex, jcs, sha256Hex, utf8 } from "@ar.io/proof";

import { PROFILE_SPEC_VERSION } from "./profile";
import type { BuildEnvelopeInput, BuiltEnvelope, EventsEnvelope } from "./types";

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RFC3339_Z_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export async function buildEnvelope(input: BuildEnvelopeInput): Promise<BuiltEnvelope> {
  if (input.environment !== "dev" && input.environment !== "production") {
    throw new Error(
      'environment is REQUIRED by ario.events/v1 and must be "dev" or "production"',
    );
  }

  const eventId = input.eventId ?? crypto.randomUUID();
  if (!UUID_V4_RE.test(eventId)) {
    throw new Error(`event_id must be a lowercase UUID v4, got ${JSON.stringify(eventId)}`);
  }
  const signedAt = input.signedAt ?? new Date().toISOString();
  if (!RFC3339_Z_RE.test(signedAt)) {
    throw new Error(`signed_at must be RFC 3339 UTC with Z, got ${JSON.stringify(signedAt)}`);
  }

  const publicKey = await input.signer.publicKey();
  if (publicKey.length !== 32) {
    throw new Error(`signer public key must be 32 bytes, got ${publicKey.length}`);
  }

  const recordCanonical = jcs(input.record);
  const recordBytes = utf8(recordCanonical);
  const payloadHash = await sha256Hex(recordBytes);

  // The pre-signature envelope: every field except `signature` (and the
  // reserved co_signatures, which this producer never emits). Field order is
  // irrelevant — JCS sorts keys.
  const preSignature: Omit<EventsEnvelope, "signature"> = {
    spec_version: PROFILE_SPEC_VERSION,
    event_id: eventId,
    payload_hash: payloadHash,
    signed_at: signedAt,
    environment: input.environment,
    public_key: bytesToHex(publicKey),
    ...(input.payloadRef !== undefined ? { payload_ref: input.payloadRef } : {}),
  };

  const signature = await input.signer.sign(utf8(jcs(preSignature)));
  if (signature.length !== 64) {
    throw new Error(`signer returned a ${signature.length}-byte signature, want 64`);
  }

  const envelope: EventsEnvelope = { ...preSignature, signature: bytesToHex(signature) };

  return {
    envelope,
    envelopeBytes: utf8(jcs(envelope)),
    recordBytes,
    payloadHash,
  };
}
