# `ario.events/v1` — profile specification

> **Status: ratified (2026-06-15).** Profile of the Verifiable Event Envelope family contract, [`envelope-spec.md` v1.3](https://github.com/ar-io/ar-io-proof/blob/main/specs/envelope-spec.md) — `ario.events/v1` is registered in the §4 registry and admitted to the accept-set in all three reference kernels (Python, TS, Go), which verify it full-family (external commitment). Producer: the `@ar.io/anchor` SDK (this repo). Motivated by [ar-io-agent#11](https://github.com/ar-io/ar-io-agent/issues/11) (the Anchoring-SDK PRD); ratified via the kernel-ratification lane.
>
> Per envelope-spec §4, profiles live with their producers; the family contract is the normative parent and this doc only fills in what the contract delegates to a profile. Where this doc and the family contract disagree, the family contract wins.

## 1. Summary

| Property | Value |
|---|---|
| `spec_version` | `ario.events/v1` |
| Producer | `@ar.io/anchor` (TypeScript SDK; future Python sibling emits the same profile) |
| Payload binding (§3) | **External commitment** — the canonical payload bytes (the *event record*, §3 below) stay in the caller's system of record; only `payload_hash` goes on-chain |
| Header disclosure (§3.1) | **Minimal** — `event_type`, `subject`, `previous_hash` live in the hash-committed event record, never in the on-chain envelope |
| `environment` (§2, v1.1 A1) | **REQUIRED** — `"dev"` \| `"production"`, inside the signed scope |
| `event_type`s | Open, grammar-constrained, adapter-namespaced (§4). Profile-reserved: `event`, `checkpoint` |
| `subject.type` | `producer` |
| Chain semantics | Optional per-key chaining via `previous_hash` in the event record core; unchained events are `"GENESIS"` singletons (§5) |
| Completeness mechanism (§5.1) | Anchor enumeration via an optional **opaque scope tag**; Merkle checkpoints for batched streams |

**Why Minimal forces external commitment.** Envelope-spec §3.1 defines Minimal as "the disclosure fields live in the hash-committed payload only — **not** in the on-chain envelope." An inline-binding profile carries its payload *in* the envelope, so an inline Minimal profile would put the disclosure fields on-chain anyway — a contradiction. `ario.events/v1` therefore declares external commitment, the same pairing as `ario.mlflow/v2` *(proposed)*. The PRD's "anchor small non-sensitive provenance inline" use case is served instead by the optional `payload_ref` locator plus the caller's retained event record; a future major could relax this if a real consumer needs true inline.

## 2. The envelope (on-chain bytes)

Exactly the family skeleton (envelope-spec §2) plus the conditional locator — nothing else. A conformant `ario.events/v1` envelope is:

```json
{
  "spec_version": "ario.events/v1",
  "event_id": "<uuid v4, lowercase>",
  "payload_hash": "<sha256-hex of JCS(event record)>",
  "signed_at": "<RFC 3339 UTC, Z>",
  "environment": "dev | production",
  "public_key": "<32-byte Ed25519 verify key, lowercase hex>",
  "signature": "<64-byte Ed25519 signature, lowercase hex>",
  "payload_ref": "<URI, OPTIONAL>"
}
```

- All family invariants apply unchanged: JCS (RFC 8785) canonicalization, SHA-256 lowercase hex, Ed25519, signature over `JCS(envelope_without_signature_and_without_co_signatures)`, self-containment.
- `environment` is **REQUIRED by this profile** (the family makes it optional). A producer MUST set it; a verifier operating at the profile layer MUST treat its absence as non-conformant for this profile. This is the cryptographic half of the SDK's structural dev/prod gate ([`distribution.md` §4.4](https://github.com/ar-io/ar-io-agent/blob/main/docs/distribution.md)): dev-mode proofs are permanently, verifiably dev.
- `payload_ref` (family §2, conditional): an optional locator URI for the event record (e.g. the S3 adapter writes the record beside the object and sets this to its key). Integrity is always `payload_hash`; the locator is never trusted.
- **No disclosure fields in the envelope** — `event_type`, `subject`, `previous_hash` are absent from the on-chain bytes per Minimal mode. A verifier MUST NOT reject their absence (family §3.1).

## 3. The event record (committed payload)

The payload this profile commits to is never the caller's raw bytes — it is a structured JSON **event record** that *itself* commits to the caller's content by hash. Raw data is hashed locally and never leaves the caller's system; the record is retained by the caller (or their adapter), and `payload_hash = SHA-256(JCS(event record))`.

The record follows the family's §3.2 owner-scoped sectioning:

```json
{
  "payload_version": 1,
  "spec_version": "ario.events/v1",
  "event_type": "<per §4>",
  "subject": { "type": "producer", "...": "..." },
  "previous_hash": "<sha256-hex | \"GENESIS\">",

  "event": {
    "content_hash": "<sha256-hex of the caller's raw bytes, OPTIONAL for checkpoint>",
    "content_length": 0,
    "ref": "<URI locating the caller's artifact, OPTIONAL>"
  },

  "context": {
    "chain_key": "<the caller's chain key, present iff chained, OPTIONAL>"
  },

  "metadata": {},

  "extras": {}
}
```

| Section | Owner | Rule (family §3.2) |
|---|---|---|
| top-level core (`payload_version`, `spec_version`, `event_type`, `subject`, `previous_hash`) | profile | Never changes. `payload_version` is `1`. The three disclosure fields live here because the profile is Minimal. |
| `event` | profile, per `event_type` | Additive-only. §4 defines the per-type schemas. |
| `context` | profile, cross-cutting | Additive-only, all optional. |
| `metadata` | **caller** | Free-form JSON. The profile MUST NOT read it for verification — namespace isolation per family §3.2. |
| `extras` | profile | Reserved. |

**Float discipline (family invariant 4).** `metadata` is caller-owned and MAY contain floats; the SDK canonicalizes the record once at creation time and the caller retains those exact canonical bytes, so verification compares against stored bytes rather than re-deriving from a live object. Profile-owned sections avoid floats entirely (`content_length` is an integer byte count). Callers re-generating records outside the SDK MUST round floats to a fixed precision before serializing.

**Content commitment.** `event.content_hash` is `SHA-256(raw bytes)` — no canonicalization of the caller's data, streams supported. A caller MAY pass a pre-computed hash instead of bytes; the SDK cannot then validate it, and the record is exactly as trustworthy as the supplied hash (a provenance statement, not an endorsement — family §9).

## 4. `event_type` vocabulary

Open and adapter-namespaced rather than a closed enum — the SDK is producer-neutral and adapters define their domains (PRD: "Adapters define their event_type vocabularies and subject types within it").

- **Grammar:** `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$`, ≤64 chars. Dot-separated segments namespace by adapter: `s3.object_stored`, `langchain.chain_end`, `vercel_ai.generation`.
- **Profile-reserved types (no namespace dot):**
  - `event` — the default single-shot anchor type when the caller supplies none. `event.content_hash` REQUIRED.
  - `checkpoint` — a Merkle checkpoint summarizing a batch window (§6). Emitted only by the batcher.
- Single-segment names other than the reserved two are reserved for future profile use; adapters MUST namespace.
- Adding an `event_type` (adapter or profile) is a **minor** change per family §2; renaming/removing is major.

## 5. `subject` and chain semantics

**`subject`** (in the record core, Minimal): identifies the producing application. `type` is always `"producer"`. Optional string fields (each ≤128 chars, `^[A-Za-z0-9_.:-]+$` per family §2): `producer_id` (a stable caller-chosen identifier; in production mode this SHOULD be the identity registered with api-guard), `name` (human label). The load-bearing identity is always the envelope's `public_key`; `subject` is context (family §2).

**Chains.** `anchor({ chain })` selects a named chain; the SDK tracks one head per `(public_key, chain_key)` via its Store. The record's `previous_hash` is the previous record's `payload_hash` on that chain, or `"GENESIS"` for the first link. An anchor call with **no** `chain` is an unchained singleton: `previous_hash = "GENESIS"`. `context.chain_key` carries the chain name (inside the committed record — not disclosed on-chain). Chain semantics are deletion/reorder-evidence for the events present (family §5.1); they are not a completeness proof.

**Checkpoint chaining (§6)** uses the same mechanism: each batcher instance is a chain, and successive `checkpoint` records link via `previous_hash`. A broken checkpoint chain is a dropped-window signal.

## 6. The `checkpoint` event and inclusion receipts

The batcher turns N events in a window into ONE anchored envelope while every event keeps a standalone, offline-verifiable inclusion proof.

- Every batched event still gets a complete signed `ario.events/v1` envelope + event record (§2/§3) — retained off-chain by the caller, **not** individually uploaded.
- **Leaf definition:** the Merkle leaf for an event is the RFC 9162 leaf hash (`0x00` prefix domain separation, as implemented by `@ar.io/proof`'s `leafHash`) over the **JCS-canonical bytes of the complete signed event envelope**. Hashing the *signed* envelope (not just `payload_hash`) makes the receipt commit to the signature too: a receipt proves "this exact signed claim was witnessed," not merely "these payload bytes were."
- The window's leaves form an RFC 9162 Merkle tree; the root goes in a `checkpoint` event record:

```json
"event": {
  "merkle_root": "<sha256-hex>",
  "leaf_count": 0,
  "window": { "start": "<RFC 3339 UTC>", "end": "<RFC 3339 UTC>" }
}
```

- The checkpoint envelope is anchored normally (single-shot upload). Its record chains to the previous checkpoint of the same batcher via core `previous_hash` (§5).
- **Inclusion receipt** (per event): `{ checkpointTxId, root, leafHash, leafIndex, auditPath, checkpointEnvelope }`. Verification is fully offline given the receipt + the event envelope bytes: recompute the leaf hash, walk `auditPath` to `root` (`@ar.io/proof` `verifyInclusion`), check `root` equals the checkpoint record's `merkle_root`, verify the checkpoint envelope's signature, and (online, optional) confirm `checkpointTxId` carries those envelope bytes.
- A batch of one is valid; an empty window anchors nothing (no empty-tree checkpoints in v1 — provable-silence heartbeats are parked per the PRD).

## 7. On-chain Arweave tags

Tags are search hints outside the signed scope (family §3.1) — never trusted, always re-verified. Minimal disclosure constrains them hard: **no event type, no subject identity, no content hash by default.**

| Tag | Value | Presence |
|---|---|---|
| `Content-Type` | `application/json` | always |
| `App-Name` | `ario-anchor` | always |
| `App-Version` | the `spec_version` (`ario.events/v1`) | always |
| `Environment` | mirrors the signed `environment` field | always |
| `Scope` | opaque scope tag (below) | optional, recommended for production |
| `Content-Hash` | `event.content_hash` | **opt-in only** (disclosure!) |

- **`Scope` — the §5.1 opaque scope tag.** `SHA-256(namespace string)`, lowercase hex, of a caller-chosen namespace. It is the profile's completeness-enumeration key: enumerate anchors by `Scope` value, reconcile against the caller's bundle into `verified / unnotarized / missing` (family §5.1). It reveals no semantics but is by design a linkability handle, so it MUST be rotation-capable — a completeness ticket lists every scope value in effect over `[from, to)` (`scope_key.kind = "opaque_scope_tag"`).
- **`Content-Hash` is a disclosure**, enabling reverse provenance lookup (artifact → proof) at the cost of publishing the content's hash linkage on-chain. It is OFF by default and enabled per-anchorer by explicit caller opt-in. (Family A2 rationale: SDK events are caller-owned; leak nothing by accident.)
- The `Environment` tag is a queryable convenience mirror; the signed `environment` field is authoritative (a mismatch is a finding).

## 8. Verification & accept-set admission

- **Kernel layer:** unchanged — `spec_version` + `payload_hash` + Ed25519 signature over the stripped scope. Any family kernel verifies an `ario.events/v1` envelope mechanically once `ario.events/v1` is in its accept-set.
- **Profile layer:** obtain the event record (caller-retained, or via `payload_ref`), confirm `payload_hash`, then read the disclosure fields from the record core. Record unavailable → **signature-valid, semantics-undetermined** (family §3.1), never "a valid event of unknown type."
- **Accept-set admission** (family §5) is a separate, explicit act per kernel, gated on the profile's conformance vectors landing in the corpus (`test-vectors-v1.1`). Registration in §4 does not auto-admit.
- Verdict vocabulary is provenance-only — "has a verifiable history," never "safe"/"approved" (family §9). `environment` surfaces as `environment_marker`; consumers MAY refuse to count dev-marked envelopes as production evidence.

## 9. Conformance vectors

The profile contributes to the family corpus via `ar-io-proof/tools/gen-vectors/` (generated, never hand-edited — governance §4):

1. A Minimal-mode `event` vector: full event record → JCS bytes → `payload_hash` → envelope-for-signing bytes → signature, fixed test keypair, `environment: "dev"`.
2. A `checkpoint` vector: leaf envelopes → RFC 9162 leaf hashes → root → checkpoint record → signed checkpoint envelope, exercising the §6 leaf definition end-to-end.
3. Negative: an `ario.events/v1` envelope carrying a top-level `event_type` (Promoted-style) — profile-layer non-conformant.

These ride the `test-vectors-v1.1` minor corpus tag (cut in `ar-io-proof`, BDFL ceremony) alongside the pending family candidates (co_signatures, external-commitment, malformed-minor negatives — [ar-io-agent#13](https://github.com/ar-io/ar-io-agent/issues/13)).

## 10. Registry row (for envelope-spec §4)

| Profile (`spec_version`) | Producer | Payload mode | Disclosure (§3.1) | `event_type`s | `subject.type` | Authoritative spec |
|---|---|---|---|---|---|---|
| `ario.events/v1` | `@ar.io/anchor` SDK | External commitment | **Minimal** | open, adapter-namespaced; profile-reserved: `event`, `checkpoint` | `producer` | this repo: `docs/profile-ario.events-v1.md` |
