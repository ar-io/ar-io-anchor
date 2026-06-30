# Changelog

All notable changes to `@ar.io/anchor-langchain` are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this package
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). This adapter
versions **independently** of the `@ar.io/anchor` + `@ar.io/anchor-s3` core (own
`langchain-v*` tag namespace). Releases prior to this file are in the git history and
GitHub releases.

## [Unreleased]

## [0.2.0] — 2026-06-30

### Changed

- **Track `@ar.io/anchor` 0.2.0** (dependency range bumped to `^0.2.0`). This makes
  opt-in raw-byte **disclosure** available to adapter users: collect the run's receipts
  with `provenance.close()`, then `anchorer.bundle(receipts, { disclose })` to embed
  selected events' raw bytes — the `JSON.stringify`'d payload the adapter committed for
  that step (capture it via `mapPayload` if you need the exact bytes) — **inside the
  signed bundle**. The result is one self-contained file carrying the run trace *and*
  its on-chain proofs. Default off; on-chain footprint unchanged. See
  [disclosure in the core README](https://github.com/ar-io/ar-io-anchor/blob/main/packages/anchor/README.md#optionally-include-the-raw-logs-opt-in-default-off).
