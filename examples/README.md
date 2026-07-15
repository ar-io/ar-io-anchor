# Examples

Plain ESM JavaScript — no build step for the examples themselves, but they
import the workspace packages, so from the repo root run once:

```bash
npm install && npm run build
```

| Example | Shows | Network |
|---|---|---|
| [`01-anchor.mjs`](01-anchor.mjs) | Anchor bytes, read the receipt, save the record, verify the envelope offline, handle the out-of-funds error | one small Turbo free-tier write |
| [`02-batch.mjs`](02-batch.mjs) | Batch 5 events into one checkpoint write; verify an inclusion proof offline | one Turbo free-tier write |
| [`03-verify-onchain.mjs`](03-verify-onchain.mjs) | Third-party verification: fetch any anchored envelope by TX ID and check it — optionally against a retained record | gateway reads only, no writes |
| [`04-s3.mjs`](04-s3.mjs) | Anchor-as-you-store with the S3 wrapper | S3 + one Turbo write |
| [`05-langchain.mjs`](05-langchain.mjs) | A LangChain run batched into one checkpoint, then serialized to a portable `trace-bundle.json` — verify it with `npx @ar.io/proof verify` | one Turbo write |
| [`06-vercel.mjs`](06-vercel.mjs) | A Vercel AI SDK call batched + correlation-id-chained, then serialized to a portable `trace-bundle.json` — verify it with `npx @ar.io/proof verify` | one Turbo write |
| [`07-disclose.mjs`](07-disclose.mjs) | Opt-in disclosure: embed one event's raw bytes inside the signed bundle, so the file carries the raw logs *and* their on-chain proofs together — `npx @ar.io/proof verify` checks both | one Turbo write |
| [`08-retain.mjs`](08-retain.mjs) | **Durable retention (T9):** inject a `Sink` (durable proof rows) + a `LogStore` (byte-exact content) once — every event's proof *and* exact committed bytes persist, then rebuild + re-verify the whole trace from disk (`sha256(stored) === committed hash`) | one Turbo write |

```bash
node examples/01-anchor.mjs
node examples/02-batch.mjs
node examples/03-verify-onchain.mjs [txId] [recordFile]
AWS_REGION=... S3_BUCKET=... node examples/04-s3.mjs
node examples/07-disclose.mjs
node examples/08-retain.mjs
```

All examples run in dev mode: auto-generated identity and wallet, envelopes
permanently marked `environment: "dev"`. For production credentials see the
[production gate](../packages/anchor/README.md#production).
