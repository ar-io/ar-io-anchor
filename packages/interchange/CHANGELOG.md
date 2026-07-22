# Changelog

All notable changes to `@ar.io/anchor-interchange` are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this package
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). This adapter
versions **independently** of the `@ar.io/anchor` + `@ar.io/anchor-s3` core (own
`interchange-v*` tag namespace).

## [Unreleased]

## [0.2.0]

### Added

- **`resumeChains` — session-chain continuity across process restarts.**
  `anchoredAuditStore(inner, anchorer, { resumeChains: { [sessionId]: lastEventId } })`
  makes a resumed session's first record chain from the previous process's
  last anchored event instead of starting a fresh chain — a restart no longer
  opens a legitimate-looking gap in the deletion-evidence. Pairs with
  `onReceipts`: persist the final receipt's `eventId` per session, hand it
  back on startup. Sessions absent from the map behave as before.

### Changed

- **Typed against Interchange itself** (requested by the Interchange team for
  their v0.2 release): the adapter now imports `AuditRecord`, `ErrorRecord`,
  `AuditStore`, and `CryptoProvider` directly from `@intx/types` (>= 0.2.2, new
  **peerDependency**) instead of defining duck-typed structural mirrors.
  Interchange 0.2 ships compiled JS + declarations on npm, which removed the
  reason the mirrors existed (0.1.x published raw TypeScript source npm
  consumers couldn't load). Imports are type-only: nothing from `@intx` loads
  at runtime and the runtime dependency tree is still exactly `@ar.io/anchor`.
- `signerFromCryptoProvider` now takes
  `Pick<CryptoProvider, "sign" | "getPublicKey">` — Interchange's own type,
  narrowed to the raw-sign surface the adapter actually uses.
- The compatibility gate (`test/intx-compat.test.ts`) shrank to its runtime
  half: fixtures still validate against Interchange's arktype schemas; the
  compile-time boundary check is now the adapter's own import sites.

### Removed

- **Breaking:** the exported mirror types `InterchangeAuditRecord`,
  `InterchangeErrorRecord`, `InterchangeAuditStore`, `InterchangeAuditAuthz`,
  and `InterchangeCryptoProvider` — use the corresponding types from
  `@intx/types/audit` and `@intx/types/runtime`. `AnchoredAuditStore` and
  `anchoredAuditStore` are no longer generic over the record types (upstream's
  `AuditStore` isn't; the generics no longer bought anything).

## [0.1.0]

### Added

- Initial release: `anchoredAuditStore(inner, anchorer)` — a structural decorator
  over Interchange's `AuditStore` that anchors every audit and error record on
  ar.io as it is committed (git stays the system of record; anchoring rides behind
  it). Per-session Merkle batching with `prev_event_id` chaining, `mapPayload`
  redaction/skip, explicit `flushSession`/`close` lifecycle, and an `onReceipts`
  hook for receipt persistence.
- `signerFromCryptoProvider(provider)` — adapts Interchange's Ed25519
  `CryptoProvider` to `@ar.io/anchor`'s `Signer`, so anchors are signed with the
  agent's existing identity key.
- `anchorRecordsFromCollector(store, records)` — convenience for hosts that hook
  `AuditCollector.flush()` directly instead of the store.
- Event vocabulary `interchange.tool_call` / `interchange.tool_blocked` /
  `interchange.error` (exported as `EVENT_TYPES`).
- Drift gate: `@intx/types` as a devDependency (nothing ships to consumers)
  with a compatibility test that typechecks every API boundary against
  Interchange's own types and validates fixtures against their runtime
  schemas. The store surface is generic over the record types, so a store
  typed with Interchange's own records decorates and hands back to
  Interchange without a cast.
