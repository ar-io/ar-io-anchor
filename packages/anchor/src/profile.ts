// ario.events/v1 — the SDK's profile of the Verifiable Event Envelope family
// (envelope-spec v1.1 §4). Minimal disclosure: the disclosure fields
// (event_type, subject, previous_hash) live in the hash-committed payload,
// never in the on-chain envelope. The `environment` field is REQUIRED by this
// profile and sits inside the signed scope, so a dev proof can never be
// presented as production evidence.

export const PROFILE_SPEC_VERSION = "ario.events/v1";
