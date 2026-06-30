# Changelog

All notable changes to `@ar.io/anchor` are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this package follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Releases prior to this
file are recorded in the git history and GitHub releases (`anchor-v*` tags).

## [Unreleased]

## [0.2.0] — 2026-06-30

### Added

- **Opt-in raw-byte disclosure in evidence bundles.** `toEvidenceBundle(receipts, …)`
  and `anchorer.bundle(receipts, …)` accept a new `disclose` option — a
  `Record<eventId, Uint8Array | string>` — that embeds an event's raw bytes as
  `events[].content` (lowercase hex) **inside the signed bundle body**. This turns a
  bundle into one self-contained, verify-anywhere file carrying the raw logs *and*
  their on-chain locations together. The disclosure rides `body_hash`, so it stays
  tamper-evident, and a content-bearing bundle still verifies green under the current
  `@ar.io/proof` (the field is additive). At assembly each disclosed event's bytes are
  asserted `sha256(bytes) === record.event.content_hash` and assembly **throws** on a
  mismatch; an event whose record has no `content_hash` is not disclosable and also
  throws. A `string` value is UTF-8 encoded. Keys for `eventId`s not in the receipt
  set are ignored, so one `disclose` map can serve bundles over disjoint subsets.
  - **Default off, privacy-preserving:** with no `disclose` map the output is
    byte-identical to before, and your **on-chain footprint is unchanged** — the
    envelope still carries only the hash. Disclosure is purely a property of the file
    you choose to hand out, per event.

  _Reported by Will Kempster ([@kempsterrrr](https://github.com/kempsterrrr)); verified
  against the `@ar.io/proof` content check (`events[].content` → `contentOk`)._
