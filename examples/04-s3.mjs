// Anchor as you store: one wrapped putObject stores the object, anchors its
// provenance, and writes the record beside it as <key>.provenance.json.
//
//   AWS_REGION=us-east-1 S3_BUCKET=my-bucket node examples/04-s3.mjs
import { S3Client } from "@aws-sdk/client-s3";

import { createAnchorer } from "@ar.io/anchor";
import { anchoredS3 } from "@ar.io/anchor-s3";

const Bucket = process.env.S3_BUCKET;
if (!Bucket) {
  console.error("set S3_BUCKET (and AWS credentials/region in the environment)");
  process.exit(1);
}

const ario = createAnchorer();
const s3 = anchoredS3(new S3Client({}), ario);

const { receipt, provenanceKey } = await s3.putObject({
  Bucket,
  Key: `anchor-example/${Date.now()}.txt`,
  Body: "object bytes — hashed locally, never sent to Arweave",
});

console.log("anchored:  ", receipt.explorerUrl);
console.log("sidecar:   ", `s3://${Bucket}/${provenanceKey}`);
console.log("verify later with examples/03-verify-onchain.mjs", receipt.txId);

await ario.close();
