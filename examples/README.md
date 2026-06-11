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

```bash
node examples/01-anchor.mjs
node examples/02-batch.mjs
node examples/03-verify-onchain.mjs [txId] [recordFile]
AWS_REGION=... S3_BUCKET=... node examples/04-s3.mjs
```

All examples run in dev mode: auto-generated identity and wallet, envelopes
permanently marked `environment: "dev"`. For production credentials see the
[production gate](../packages/anchor/README.md#production).
