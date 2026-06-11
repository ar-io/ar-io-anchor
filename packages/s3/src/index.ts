// @ar.io/anchor-s3 — anchor as you store. Wrap an S3 client and every
// putObject also (1) anchors a tamper-evident provenance record on Arweave
// and (2) stores that record beside the object as `<key>.provenance.json`,
// so the bucket carries its own audit trail. Raw object bytes are hashed
// locally and never leave your infrastructure.

import type { Anchorer, AnchorReceipt } from "@ar.io/anchor";
import {
  PutObjectCommand,
  type PutObjectCommandInput,
  type S3Client,
} from "@aws-sdk/client-s3";

export interface AnchoredPutResult {
  receipt: AnchorReceipt;
  provenanceKey: string;
}

export interface AnchoredS3 {
  putObject(
    input: PutObjectCommandInput & { Body: string | Uint8Array },
  ): Promise<AnchoredPutResult>;
}

export function anchoredS3(client: S3Client, anchorer: Anchorer): AnchoredS3 {
  return {
    async putObject(input) {
      const { Bucket, Key, Body } = input;
      if (!Bucket || !Key) throw new Error("anchoredS3: Bucket and Key are required");

      // 1. Store the object exactly as the caller asked.
      await client.send(new PutObjectCommand(input));

      // 2. Anchor its provenance: hash locally, sign, one small write to
      //    Arweave. The receipt resolves when Turbo accepts the upload.
      const receipt = await anchorer.anchor({
        type: "s3.object_stored",
        data: Body,
        ref: `s3://${Bucket}/${Key}`,
      });

      // 3. Keep the committed record beside the object (Minimal disclosure:
      //    the on-chain envelope reveals nothing — this sidecar is what a
      //    future auditor verifies against, fully offline).
      const provenanceKey = `${Key}.provenance.json`;
      await client.send(
        new PutObjectCommand({
          Bucket,
          Key: provenanceKey,
          ContentType: "application/json",
          Body: JSON.stringify({
            txId: receipt.txId,
            gatewayUrl: receipt.gatewayUrl,
            envelope: receipt.envelope,
            record: JSON.parse(new TextDecoder().decode(receipt.recordBytes)),
            contentHash: receipt.contentHash,
            environment: receipt.environment,
          }),
        }),
      );

      return { receipt, provenanceKey };
    },
  };
}
