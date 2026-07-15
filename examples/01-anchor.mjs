// Anchor a piece of data, inspect the receipt, save the record you must
// retain, and verify the envelope offline — no gateway involved.
import { writeFile } from "node:fs/promises";

import { createAnchorer } from "@ar.io/anchor";
import { ed25519Verify, jcs, utf8 } from "@ar.io/proof";

const ario = createAnchorer(); // dev mode: zero config, Turbo free tier

let receipt;
try {
  receipt = await ario.anchor({
    data: `hello from the anchor example, ${new Date().toISOString()}`,
    ref: "example://01-anchor", // optional locator, stays in the record
    metadata: { example: "01" }, // caller-owned, never read by the SDK
  });
} catch (err) {
  if (err.code === "FUNDING_EXHAUSTED") {
    // The free-tier wallet ran dry. err.message says how to fund.
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

console.log("tx:        ", receipt.txId);
console.log("explorer:  ", `https://viewblock.io/arweave/tx/${receipt.txId}`);
console.log("contentHash:", receipt.contentHash);

// The on-chain envelope reveals nothing about your event (Minimal
// disclosure). The RECORD is what payload_hash commits to — retain it;
// without it a verifier can prove the signature but not the semantics.
await writeFile("anchor-record.json", receipt.recordBytes);
console.log("record saved to anchor-record.json — keep it with your data");

// Offline verification, right now, no network: the signature covers
// JCS(envelope minus signature).
const { signature, ...preSignature } = receipt.envelope;
const ok = await ed25519Verify(signature, utf8(jcs(preSignature)), receipt.envelope.public_key);
console.log("envelope signature verifies offline:", ok);

await ario.close();
