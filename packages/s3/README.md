# @ar.io/anchor-s3

Anchor as you store. Wrap your S3 client once, and every `putObject` also:

1. stores your object exactly as asked,
2. anchors a tamper-evident provenance record to ar.io (your bytes are hashed locally — they never leave your infrastructure), and
3. writes that record beside the object as `<key>.provenance.json`, so the bucket carries its own offline-verifiable audit trail.

```bash
npm install @ar.io/anchor-s3 @ar.io/anchor @aws-sdk/client-s3
```

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

`Body` must be a `string` or `Uint8Array` (it is hashed in-process; streams aren't accepted here).

## Verifying a sidecar

The sidecar is JSON: `{ txId, explorerUrl, envelope, record, contentHash, environment }`. Anyone with the object and its sidecar can verify offline with the read-only [`@ar.io/proof`](https://www.npmjs.com/package/@ar.io/proof) — no ar.io service in the trust path:

```ts
import { ed25519Verify, jcs, sha256Hex, utf8 } from "@ar.io/proof";

const sidecar = JSON.parse(sidecarJson);

// 1. The object bytes are what was anchored.
(await sha256Hex(objectBytes)) === sidecar.record.event.content_hash;

// 2. The record is what the envelope committed to.
(await sha256Hex(utf8(jcs(sidecar.record)))) === sidecar.envelope.payload_hash;

// 3. The envelope is authentically signed.
const { signature, ...pre } = sidecar.envelope;
await ed25519Verify(signature, utf8(jcs(pre)), sidecar.envelope.public_key);
```

Cross-check against the chain by fetching `txId` from any gateway (`https://arweave.net/raw/<txId>`) and comparing it to `sidecar.envelope`.

## Semantics

- If anchoring fails, the object is already stored but no sidecar is written — the put itself is never rolled back.
- For production credentials (explicit signing key, funded wallet) and the typed-error table: see [`@ar.io/anchor`](https://www.npmjs.com/package/@ar.io/anchor).
