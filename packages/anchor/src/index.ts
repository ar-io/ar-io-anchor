// @ar.io/anchor — TypeScript write path of the ar.io verification stack.
//
// Builds signed Verifiable Event Envelopes under the ario.events/v1 profile
// (envelope-spec v1.1, Minimal disclosure), assembles ANS-104 data items,
// uploads via Turbo, and Merkle-batches high-frequency events with per-event
// inclusion proofs. The verify side is the separate read-only @ar.io/proof —
// this package consumes its primitives and never re-implements verification.

export { PROFILE_SPEC_VERSION } from "./profile";
