# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What This Is

The TypeScript write path of the ar.io verification stack. Two npm-workspace packages: `@ar.io/anchor` (envelope assembly → ANS-104 data item → Turbo upload → receipt; Merkle batcher; dev/prod gate) and `@ar.io/anchor-s3` (S3 wrapper adapter). The verify side is the separate `@ar.io/proof` package — consume it, never re-implement verification.

## Commands

```bash
npm install
npm run build          # tsc, all workspaces — REQUIRED before typecheck (s3 resolves anchor types from dist/)
npm run typecheck
npm test               # vitest, all packages
npx vitest run packages/anchor/test/batch.test.ts   # single file
ANCHOR_LIVE_SMOKE=1 npx vitest run packages/anchor/test/live-smoke.test.ts  # real Turbo write — never in CI
node examples/01-anchor.mjs   # runnable examples; 01/02/04 each make one free-tier write
```

## Binding contracts

- **Family contract:** [`envelope-spec.md`](https://github.com/ar-io/ar-io-proof/blob/main/specs/envelope-spec.md) v1.1+ in `ar-io-proof`. This repo's profile is `ario.events/v1` (registered §4, v1.2): **Minimal disclosure + external commitment + `environment` REQUIRED**. The authoritative profile spec is [`docs/profile-ario.events-v1.md`](docs/profile-ario.events-v1.md) — change wire behavior only in lockstep with it.
- **Corpus pin:** `test-vectors-v1.1`, vendored at `packages/anchor/test-vectors/` — generated in `ar-io-proof`, never hand-edited here. Re-pin discipline: [`VENDORING.md`](packages/anchor/test-vectors/VENDORING.md). `conformance.test.ts` must reproduce every vector byte-for-byte.
- **Governance:** corpus changes and profile-spec changes go through `ar-io-proof` PRs (BDFL merges). Never tag a corpus version yourself. **No npm publish without coordinator green light.**

## Byte-level landmines (each one has shipped a real bug somewhere in this stack)

1. **ANS-104 deep hash uses the DECIMAL-STRING signature type** (`"2"`), while the wire layout uses 2-byte LE. Mixing them yields items Turbo rejects as "Invalid Data Item!" (agent commit `d43d432b`).
2. **ed25519 (sigType 2) signs the raw 48-byte deep hash.** The extra SHA-256 round you'll see on the Arweave path is RSA-PSS-specific — adding it to the ed25519 path breaks the signature.
3. **The envelope signed scope strips `signature` AND `co_signatures`** before JCS canonicalization — even though this producer never emits `co_signatures`.
4. **Relative imports in `src/` need explicit `.js` extensions.** The build is ESM consumed by plain Node; extension-less imports pass vitest (bundler resolution) and then break every Node consumer (this bit `@ar.io/proof@0.1.1`, fixed in 0.1.2, and nearly shipped here in 0.1.0 — caught by `node examples/01-anchor.mjs`). Running an example is the cheapest pre-publish check.

## Architecture (packages/anchor/src)

| Module | One job |
|---|---|
| `record.ts` | Event record (the committed payload): §3.2 sectioning, event_type grammar, chain semantics |
| `envelope.ts` | Record → payload_hash → signed Minimal-mode skeleton; emits the canonical upload bytes |
| `signer.ts` | `Signer` plug point + local Ed25519 implementation (dev/test; KMS adapters implement the same interface) |
| `deephash.ts` / `avro.ts` | Arweave deep hash; ANS-104 Avro tag encoding |
| `dataitem.ts` | ANS-104 wire assembly + `DataItemSigner` (funding chain plug; Solana ed25519 default) + TX ID prediction |
| `tags.ts` | On-chain tags, Minimal-constrained: no event type/identity; `Content-Hash` opt-in; hashed `Scope` |
| `turbo.ts` | `Uploader` plug point + fetch-based Turbo POST with bounded retries |
| `errors.ts` | Typed error family (`err.code`); `FundingExhaustedError` is deliberately prescriptive |
| `store.ts` | `Store` plug point (chain heads + batcher pending buffer); `MemoryStore` default |
| `batch.ts` | Merkle batcher: N events → 1 checkpoint write, per-event inclusion receipts |
| `anchorer.ts` | `createAnchorer()` — the structural dev/prod gate — and the single upload pipeline |

Two signing roles, never conflated: the **envelope identity key** (always Ed25519, family contract) and the **data-item funding signer** (chain-pluggable). Runtime deps stay minimal by policy: `@ar.io/proof` + `@noble/ed25519` + `@noble/hashes`, nothing else; `arbundles`/`axios`/`bs58` are byte-pinning devDeps only. No relay/bundler in the upload path, ever.

## Testing map (the PRD's 8 seams)

| Test file | Seam |
|---|---|
| `conformance.test.ts` | 1 — corpus byte-conformance (vendored vectors) |
| `live-smoke.test.ts` + Python kernel cross-checks | 2, 8 — cross-product, gated live smoke |
| `dataitem-arbundles.test.ts`, `dataitem-python.test.ts` | 3 — byte-pin vs arbundles; independent parse via `tools/ans104-conformance/` (vendored from ar-io-agent; never edit in place) |
| `turbo.test.ts`, `anchorer.test.ts` (StubUploader) | 4 — stub uploader, network-free behavior |
| `envelope.test.ts`, `anchorer.test.ts` | 5 — signer/store contracts |
| `packages/s3/test/s3.test.ts` | 6 — spy anchorer, zero crypto/network (the pattern for all future adapters) |
| `batch.test.ts` (FakeClock) | 7 — batcher timers as pure logic |

CI (`.github/workflows/ci.yml`) runs build → typecheck → test and **fails if the Python ANS-104 validation silently skips**. Keep that guard.

## Conventions

- Strict TS, ESM, `moduleResolution: bundler` for dev/tests; published code must stay plain-Node loadable (landmine 4).
- Verdict/scope language is provenance-only: "has a verifiable history" — never "safe"/"approved".
- Commits: small, green, test-driven, `Co-Authored-By: Claude <model> <noreply@anthropic.com>` trailer.
- Releases: version bump + tag → `.github/workflows/release.yml` (npm OIDC trusted publishing). Coordinator-gated.
- Package READMEs ship to npm: use absolute GitHub URLs, never relative links that escape the tarball.
