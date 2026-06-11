// Third-party verification: given only a TX ID, fetch the envelope from a
// gateway and check it. No ar.io service is trusted — every claim is
// re-checked against the signature. Reads only, writes nothing.
//
//   node examples/03-verify-onchain.mjs [txId] [recordFile]
//
// With just a txId you can prove WHO signed WHAT bytes WHEN — but not what
// the event meant: under Minimal disclosure the semantics live in the
// record the producer retained. Pass the record file to complete the check.
import { readFile } from "node:fs/promises";

import { ed25519Verify, jcs, sha256Hex, utf8 } from "@ar.io/proof";

const txId = process.argv[2] ?? "nFwocIhOfbM3VxjKuyhnEPdP4ssAIYlFOCslcbFsWuk";
const recordFile = process.argv[3];

// Try more than one gateway — delivery is untrusted either way.
const gateways = ["https://arweave.net", "https://permagate.io"];
let envelope;
for (const gw of gateways) {
  const res = await fetch(`${gw}/raw/${txId}`);
  if (res.ok) {
    envelope = await res.json();
    console.log(`fetched from ${gw}`);
    break;
  }
  console.warn(`${gw}: HTTP ${res.status}`);
}
if (!envelope) throw new Error("no gateway served the transaction");

// 1. Signature: covers JCS(envelope minus signature and co_signatures).
const { signature, co_signatures: _cs, ...preSignature } = envelope;
const sigOk = await ed25519Verify(signature, utf8(jcs(preSignature)), envelope.public_key);
console.log("spec_version:", envelope.spec_version);
console.log("environment: ", envelope.environment, "(inside the signed bytes — dev can never pose as production)");
console.log("signed_at:   ", envelope.signed_at, "(advisory; witnessed time comes from the block)");
console.log("signature:   ", sigOk ? "VALID" : "INVALID");

// 2. Semantics: only provable against the retained record.
if (recordFile) {
  const recordBytes = await readFile(recordFile);
  const hashOk = (await sha256Hex(recordBytes)) === envelope.payload_hash;
  console.log("record hash: ", hashOk ? "MATCHES payload_hash" : "DOES NOT MATCH");
  if (hashOk) {
    const record = JSON.parse(new TextDecoder().decode(recordBytes));
    console.log("event_type:  ", record.event_type);
    console.log("content_hash:", record.event.content_hash);
  }
} else {
  console.log("no record file given → signature-valid, semantics-undetermined");
  console.log("(run 01-anchor.mjs first, then pass its txId and anchor-record.json)");
}
