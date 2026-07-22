# ar-io-anchor

> Packages `@ar.io/anchor`, `@ar.io/anchor-s3`, `@ar.io/anchor-langchain`, `@ar.io/anchor-vercel` (+ `@ar.io/anchor-interchange`, see the table) — **v0.2.0 on npm**. Profile [`ario.events/v1`](docs/profile-ario.events-v1.md), registered in [`envelope-spec.md`](https://github.com/ar-io/ar-io-proof/blob/main/specs/envelope-spec.md) §4. Origin: [ar-io-agent#11](https://github.com/ar-io/ar-io-agent/issues/11).
>
> **On `main`, shipping in the next release (`0.4.0`):** durable **proof + content retention** (the `Sink` / `LogStore` seams — [example 08](examples/08-retain.mjs)) and support for the **attested evidence export** (`proof export` in [`@ar.io/proof`](https://www.npmjs.com/package/@ar.io/proof)). See [Durable retention](#durable-retention-sink--logstore) and [Production enrollment](#production-enrollment-producerenroll) below.

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

## Durable retention (`Sink` + `LogStore`)

> Ships in `@ar.io/anchor` **0.4.0** (on `main` today). Runnable: [`examples/08-retain.mjs`](examples/08-retain.mjs).

"Retain your receipts *and* the exact bytes you anchored" is a first-class injected side effect, not the caller's homework. Inject either seam **once** and it applies to `anchor()` and the batcher alike — every adapter (LangChain / Vercel / S3) inherits it for free, below the adapter seam:

- **`Sink`** — one durable proof row per event (signed envelope + committed record + proof) and per checkpoint. `FsSink` (JSON-lines), `CallbackSink` (pipe into your own log/queue), or your own.
- **`LogStore`** — the exact committed bytes, content-addressed, so `sha256(stored) === content_hash` is structurally guaranteed (the silent audit-time-only "stored bytes ≠ anchored hash" failure is gone). `FsLogStore`, `CallbackLogStore`, or your own.

```ts
import { createAnchorer, FsSink, FsLogStore } from "@ar.io/anchor";

const ario = createAnchorer({
  sink: new FsSink("proofs.jsonl"),      // durable proof rows
  logStore: new FsLogStore("content/"),  // byte-exact content retention
  // onRetentionError: "skip-anchor" (default, strict) — a store failure fails the
  // event LOUDLY rather than anchoring a proof whose bytes you never kept.
});

const receipt = await ario.anchor({ data: bytes });

// later, entirely from disk — no in-memory receipts, no network:
const rows = FsSink.read("proofs.jsonl");                              // rebuild the trace
const bytes2 = await new FsLogStore("content/").get(receipt.eventId);  // the exact bytes
```

## Production enrollment (`producer:enroll`)

> Server side lives in **ar-io-api-guard** ([#59](https://github.com/ar-io/ar-io-api-guard/pull/59)); `createAnchorer({ apiGuard })` carries the config.

Production evidence needs your signing key bound to a real identity. api-guard's `producer:enroll` does this with **challenge-signature proof-of-possession** — no key material ever leaves the producer:

1. `POST /api-guard/producer/challenge` → a single-use nonce bound to `(org, producer, key)` (needs an API key scoped `producer:enroll`).
2. Sign the nonce with your Ed25519 producer key.
3. `POST /api-guard/producer/register` with the public key + signature → the roster records the key ↔ identity binding.

```ts
// Production mode structurally refuses auto-generated secrets:
const ario = createAnchorer({
  environment: "production",
  signer, wallet, subject,       // explicit — throws without them
  apiGuard: { baseUrl, apiKey },  // the producer:enroll surface
});
```

## Examples

Runnable, in [`examples/`](examples/): anchor + offline verify, batch + inclusion proof, third-party verification of any on-chain envelope, and the S3 round-trip. `npm install && npm run build`, then `node examples/01-anchor.mjs`.

## Packages

| Package | What |
|---|---|
| [`packages/anchor`](packages/anchor) (`@ar.io/anchor`) | Envelope assembly, Signer interface, hand-rolled ANS-104 builder (ed25519 sigType 2), fetch-based Turbo uploader, Merkle batcher, dev/prod gate. Runtime deps: `@ar.io/proof` + `@noble/{ed25519,hashes}` — nothing else. |
| [`packages/s3`](packages/s3) (`@ar.io/anchor-s3`) | The S3 wrapper adapter. Dependencies point adapter → core, never back. |
| [`packages/langchain`](packages/langchain) (`@ar.io/anchor-langchain`) | LangChain.js callback handler: the agent's run tree as a Merkle-batched, deletion-evident event chain. |
| [`packages/vercel`](packages/vercel) (`@ar.io/anchor-vercel`) | Vercel AI SDK middleware: every generation anchored on the batcher hot path. |
| [`packages/interchange`](packages/interchange) (`@ar.io/anchor-interchange`) | [Interchange](https://github.com/faremeter/interchange) AuditStore decorator: per-session anchored audit chains, signed with the agent's own identity key (typed against `@intx/types` ≥ 0.2 as a type-only peer — runtime deps stay `@ar.io/anchor` only). |

## Conformance & proof

- Profile: [`docs/profile-ario.events-v1.md`](docs/profile-ario.events-v1.md) — Minimal disclosure, external commitment, `environment` required.
- Corpus: byte-for-byte against `test-vectors-v1.1` (vendored, [re-pin discipline](packages/anchor/test-vectors/VENDORING.md)).
- ANS-104: byte-pinned vs arbundles (dev-only dep) + re-verified by the agent's independent Python parser in CI.
- Live: single-shot [`nFwoc…Wuk`](https://viewblock.io/arweave/tx/nFwocIhOfbM3VxjKuyhnEPdP4ssAIYlFOCslcbFsWuk), batched checkpoint (3 leaves, one write) [`Jvnc…DpM`](https://viewblock.io/arweave/tx/JvncbVlUaf0ggmkAbS1coi6eeI2n1oxseoexYdaYDpM) — both gateway-fetched and cross-verified by the Python kernel.

## Development

```bash
npm install
npm test          # vitest — all packages (180+ tests)
npm run build     # tsc build of all workspaces
npm run typecheck
ANCHOR_LIVE_SMOKE=1 npx vitest run packages/anchor/test/live-smoke.test.ts  # real Turbo, never in CI
```

## Follow-on lanes

- **LangChain.js / Vercel AI SDK / Interchange adapters** — **shipped**: `@ar.io/anchor-langchain` + `@ar.io/anchor-vercel` (0.2.0 on npm; examples [05](examples/05-langchain.mjs) / [06](examples/06-vercel.mjs)), and `@ar.io/anchor-interchange` — the [Interchange](https://github.com/faremeter/interchange) AuditStore decorator (see the package table).
- **Durable retention (`Sink` / `LogStore`)** and **`producer:enroll`** — **shipped** (see [Durable retention](#durable-retention-sink--logstore) and [Production enrollment](#production-enrollment-producerenroll)); on `main`, releasing in 0.4.0.
- **Attested evidence export** — **shipped in [`@ar.io/proof`](https://www.npmjs.com/package/@ar.io/proof)**: compose a signed, offline-verifiable `ario.evidence.export/v1` (recomputed kernel verdict + operator attestations) with `proof export`, verify with `proof verify`.
- **Receipt persistence inside Interchange** — an upstream PR to [faremeter/interchange](https://github.com/faremeter/interchange) wiring `anchoredAuditStore` into the sidecar composition layer and persisting receipts to `state/anchor/{sessionId}/`.
- **Python anchor sibling** — a Python *write* path mirroring this architecture (the `ar-io-proof` verify kernel is already polyglot); not yet built.
