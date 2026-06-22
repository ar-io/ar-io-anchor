// Anchor a LangChain.js run: one callback handler, a whole agent session
// batched into ONE Arweave write, every step individually inclusion-proofed
// and offline-verified. Uses FakeListChatModel so the example needs no LLM
// key — swap in any real model; the handler doesn't change.
//
// Makes one real free-tier Turbo write (dev mode), like examples 01/02/04.
import { writeFile } from "node:fs/promises";

import { createAnchorer, LocalEd25519Signer, toEvidenceBundle } from "@ar.io/anchor";
import { FakeListChatModel } from "@langchain/core/utils/testing";

import { anchorCallbacks } from "@ar.io/anchor-langchain";

// Hold the signer so we can serialize a trace bundle below; dev mode otherwise
// auto-generates one. (The bundle wrapper is signed with this same key.)
const signer = LocalEd25519Signer.generate();
const ario = createAnchorer({ signer }); // dev mode: Turbo free tier, our signer
const provenance = anchorCallbacks(ario, {
  batch: { maxEvents: 16, maxAge: 30_000, name: "example-05" },
});

const model = new FakeListChatModel({ responses: ["The run tree IS the audit trail."] });
const answer = await model.invoke("Why anchor agent steps?", { callbacks: [provenance] });
console.log("agent said:", answer.content, "\n");

const receipts = await provenance.close();
console.log(`${receipts.length} events → 1 checkpoint: ${receipts[0].gatewayUrl}\n`);

// Serialize the whole session into ONE signed, portable, self-verifying bundle.
// An auditor verifies it offline with one command — no write SDK required.
const bundle = await toEvidenceBundle(receipts, {
  signer,
  issuer: { kind: "producer", producer_id: "example-05" },
});
await writeFile("trace-bundle.json", JSON.stringify(bundle, null, 2));

console.log("wrote trace-bundle.json — verify it yourself with the read-only kernel:\n");
console.log("  npx @ar.io/proof verify trace-bundle.json");
console.log("  # also confirm each checkpoint is anchored on-chain:");
console.log("  npx @ar.io/proof verify trace-bundle.json https://arweave.net,https://permagate.io\n");
console.log("(implemented on main; live once @ar.io/anchor and @ar.io/proof publish their next versions)");
