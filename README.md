# ar-io-anchor

> **Status: Wave 3 T-SDK lane, in active development.** Working repo name — package is `@ar.io/anchor`. PRD: [ar-io-agent#11](https://github.com/ar-io/ar-io-agent/issues/11). Binding family contract: [`envelope-spec.md` v1.1](https://github.com/ar-io/ar-io-proof/blob/main/specs/envelope-spec.md). No npm publish without coordinator green light.

The **TypeScript write path** of the ar.io verification stack: take bytes (or a pre-computed hash) plus minimal metadata → signed event envelope under the `ario.events/v1` profile → ANS-104 data item → Turbo upload → receipt. Raw data is hashed locally and **never uploaded**.

The verify side is the separate, read-only [`@ar.io/proof`](https://www.npmjs.com/package/@ar.io/proof) — this SDK consumes its primitives and never re-implements verification.

## Packages

| Package | What |
|---|---|
| [`packages/anchor`](packages/anchor) (`@ar.io/anchor`) | Envelope assembly, Signer interface, ANS-104 builder, Turbo uploader, Merkle batcher, the structural dev/prod gate. |

Workspace-ready: `@ar.io/envelope` may split out later; until then the envelope kernel primitives come from `@ar.io/proof`.

## Conformance

- Profile: `ario.events/v1` ([`docs/profile-ario.events-v1.md`](docs/profile-ario.events-v1.md)) — Minimal disclosure, `environment` required in the signed scope.
- Corpus pin: `test-vectors-v1.0` (authoritative home [`ar-io-proof/test-vectors/`](https://github.com/ar-io/ar-io-proof/tree/main/test-vectors)); `ario.events/v1` vectors land via the corpus `v1.1` minor tag.
- ANS-104 output is byte-pinned against arbundles and independently parsed by [`ar-io-agent/tools/ans104-conformance`](https://github.com/ar-io/ar-io-agent/tree/main/tools/ans104-conformance).

## Development

```bash
npm install
npm test          # vitest — all packages
npm run build     # tsc build of @ar.io/anchor
npm run typecheck
```
