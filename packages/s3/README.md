# @ar.io/anchor-s3

Anchor as you store. Wrap your S3 client once, and every `putObject` also:

1. stores your object exactly as asked,
2. anchors a tamper-evident provenance record on Arweave (your bytes are hashed locally — they never leave your infrastructure), and
3. writes that record beside the object as `<key>.provenance.json`, so the bucket carries its own offline-verifiable audit trail.

```ts
import { S3Client } from "@aws-sdk/client-s3";
import { createAnchorer } from "@ar.io/anchor";
import { anchoredS3 } from "@ar.io/anchor-s3";

const s3 = anchoredS3(new S3Client({}), createAnchorer()); // dev mode: zero config

const { receipt, provenanceKey } = await s3.putObject({
  Bucket: "models",
  Key: "prod/scorer.pkl",
  Body: modelBytes,
});

receipt.txId;        // permanent Arweave anchor for these exact bytes
provenanceKey;       // "prod/scorer.pkl.provenance.json" — verify offline, anytime
```

Later, anyone with the object and its sidecar can prove the bytes are exactly what was stored — using the read-only [`@ar.io/proof`](https://www.npmjs.com/package/@ar.io/proof) verifier, no ar.io service in the trust path.

For production (explicit signing key, funded wallet) and error handling: see [`@ar.io/anchor`](https://www.npmjs.com/package/@ar.io/anchor). If anchoring fails, the object is already stored but no sidecar is written — the put itself is never rolled back.
