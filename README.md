# ar-io-anchor

> Packages `@ar.io/anchor` and `@ar.io/anchor-s3`, v0.1.0. Profile [`ario.events/v1`](docs/profile-ario.events-v1.md), registered in [`envelope-spec.md`](https://github.com/ar-io/ar-io-proof/blob/main/specs/envelope-spec.md) §4. Origin: [ar-io-agent#11](https://github.com/ar-io/ar-io-agent/issues/11).

The **TypeScript write path** of the ar.io verification stack: take bytes (or a pre-computed hash) plus minimal metadata → signed event envelope under `ario.events/v1` → ANS-104 data item → Turbo upload → receipt. Raw data is hashed locally and **never uploaded**. The verify side is the separate read-only [`@ar.io/proof`](https://www.npmjs.com/package/@ar.io/proof).

## Quickstart

```ts
import { createAnchorer } from "@ar.io/anchor";

const ario = createAnchorer(); // dev mode: zero config, free tier
const receipt = await ario.anchor({ data: fileBytes, ref: "s3://bucket/key" });
receipt.txId; // permanent Arweave anchor — resolved when Turbo accepted
```

High-frequency events? The **Merkle batcher** turns N events into one Arweave write per window — every event keeps its own offline-verifiable inclusion proof:

```ts
const batch = ario.batch({ maxEvents: 100, maxAge: 60_000, flushOnIdle: 5_000 });
const receipt = await batch.add({ data: JSON.stringify(llmStep) }).receipt();
// → { checkpointTxId, root, leafHash, leafIndex, auditPath, envelope, ... }
await ario.close(); // explicit flush — serverless/script safe
```

Anchor-as-you-store for S3 (the hello-world adapter, ~50 lines):

```ts
import { anchoredS3 } from "@ar.io/anchor-s3";
const s3 = anchoredS3(new S3Client({}), ario);
await s3.putObject({ Bucket, Key, Body }); // object + on-chain anchor + sidecar record
```

Production structurally refuses auto-generated secrets — `createAnchorer({ environment: "production", signer, wallet, subject })` throws without explicit credentials, and `environment` is stamped *inside the signed bytes*. Setup and the typed-error table: [`packages/anchor/README.md`](packages/anchor/README.md).

## Examples

Runnable, in [`examples/`](examples/): anchor + offline verify, batch + inclusion proof, third-party verification of any on-chain envelope, and the S3 round-trip. `npm install && npm run build`, then `node examples/01-anchor.mjs`.

## Packages

| Package | What |
|---|---|
| [`packages/anchor`](packages/anchor) (`@ar.io/anchor`) | Envelope assembly, Signer interface, hand-rolled ANS-104 builder (ed25519 sigType 2), fetch-based Turbo uploader, Merkle batcher, dev/prod gate. Runtime deps: `@ar.io/proof` + `@noble/{ed25519,hashes}` — nothing else. |
| [`packages/s3`](packages/s3) (`@ar.io/anchor-s3`) | The S3 wrapper adapter. Dependencies point adapter → core, never back. |

## Conformance & proof

- Profile: [`docs/profile-ario.events-v1.md`](docs/profile-ario.events-v1.md) — Minimal disclosure, external commitment, `environment` required.
- Corpus: byte-for-byte against `test-vectors-v1.1` (vendored, [re-pin discipline](packages/anchor/test-vectors/VENDORING.md)).
- ANS-104: byte-pinned vs arbundles (dev-only dep) + re-verified by the agent's independent Python parser in CI.
- Live: single-shot [`nFwoc…Wuk`](https://viewblock.io/arweave/tx/nFwocIhOfbM3VxjKuyhnEPdP4ssAIYlFOCslcbFsWuk), batched checkpoint (3 leaves, one write) [`Jvnc…DpM`](https://viewblock.io/arweave/tx/JvncbVlUaf0ggmkAbS1coi6eeI2n1oxseoexYdaYDpM) — both gateway-fetched and cross-verified by the Python kernel.

## Development

```bash
npm install
npm test          # vitest — all packages (84+ tests)
npm run build     # tsc build of all workspaces
npm run typecheck
ANCHOR_LIVE_SMOKE=1 npx vitest run packages/anchor/test/live-smoke.test.ts  # real Turbo, never in CI
```

## Follow-on lanes (breadcrumbs, not built here)

- **LangChain.js / Vercel AI SDK adapter** — callback-shaped, exercises the batcher on the hot path. Test seam: spy anchorer (see `packages/s3/test`).
- **api-guard `producer:enroll`** — production-mode public-key registration; `createAnchorer({ apiGuard })` already accepts the config shape and the SDK stubs against it.
- **Python anchor sibling** (`ar-io-proof` v0.2+) — same architecture, same corpus.
