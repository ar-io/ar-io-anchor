// Anchor a LangChain.js run: one callback handler, a whole agent session
// batched into ONE Arweave write, every step individually inclusion-proofed
// and offline-verified. Uses FakeListChatModel so the example needs no LLM
// key — swap in any real model; the handler doesn't change.
//
// Makes one real free-tier Turbo write (dev mode), like examples 01/02/04.
import { createAnchorer } from "@ar.io/anchor";
import { hexToBytes, verifyEnvelope, verifyInclusion } from "@ar.io/proof";
import { FakeListChatModel } from "@langchain/core/utils/testing";

import { anchorCallbacks } from "@ar.io/anchor-langchain";

const ario = createAnchorer(); // dev mode: zero config, Turbo free tier
const provenance = anchorCallbacks(ario, {
  batch: { maxEvents: 16, maxAge: 30_000, name: "example-05" },
});

const model = new FakeListChatModel({ responses: ["The run tree IS the audit trail."] });
const answer = await model.invoke("Why anchor agent steps?", { callbacks: [provenance] });
console.log("agent said:", answer.content, "\n");

const receipts = await provenance.close();
console.log(`${receipts.length} events → 1 checkpoint: ${receipts[0].gatewayUrl}\n`);

for (const r of receipts) {
  const lc = JSON.parse(new TextDecoder().decode(r.recordBytes)).metadata.langchain;
  // Full-family verify (@ar.io/proof 0.2.0): supplying the retained record
  // bytes gives the green end-to-end result — spec + signature + binding.
  const result = await verifyEnvelope(r.envelope, { payloadBytes: r.recordBytes });
  const inclusionOk = await verifyInclusion(
    hexToBytes(r.leafHash),
    r.leafIndex,
    r.leafCount,
    r.auditPath.map(hexToBytes),
    hexToBytes(r.root),
  );
  console.log(
    `leaf ${r.leafIndex}/${r.leafCount}  seq ${lc.seq}  prev ${lc.prev_event_id?.slice(0, 8) ?? "—"}`,
    `verified=${result.ok} signature=${result.signatureOk} binding=${result.payloadHashOk} inclusion=${inclusionOk}`,
  );
}
console.log("\nRetain each receipt's recordBytes — that is what the hash commits to.");
