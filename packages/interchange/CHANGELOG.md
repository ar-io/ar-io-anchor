# Changelog

All notable changes to `@ar.io/anchor-interchange` are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this package
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). This adapter
versions **independently** of the `@ar.io/anchor` + `@ar.io/anchor-s3` core (own
`interchange-v*` tag namespace).

## [Unreleased]

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
