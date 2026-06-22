// Anchor Vercel AI SDK calls: one middleware, a request's calls batched into
// ONE Arweave write, each call individually inclusion-proofed and offline-
// verified. Uses MockLanguageModelV3 so the example needs no LLM key — swap
// in any real model (openai("gpt-4o"), etc.); the middleware doesn't change.
//
// Makes one real free-tier Turbo write (dev mode), like examples 01/02/04/05.
import { writeFile } from "node:fs/promises";

import { createAnchorer, LocalEd25519Signer, toEvidenceBundle } from "@ar.io/anchor";
import { generateText, wrapLanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";

import { anchorMiddleware } from "@ar.io/anchor-vercel";

// Hold the signer so we can serialize a trace bundle below; dev mode otherwise
// auto-generates one. (The bundle wrapper is signed with this same key.)
const signer = LocalEd25519Signer.generate();
const ario = createAnchorer({ signer }); // dev mode: Turbo free tier, our signer
const provenance = anchorMiddleware(ario, {
  batch: { maxEvents: 16, maxAge: 30_000, name: "example-06" },
});

const model = wrapLanguageModel({
  model: new MockLanguageModelV3({
    doGenerate: async () => ({
      finishReason: "stop",
      usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
      content: [{ type: "text", text: "The model wraps; the chain links." }],
      warnings: [],
    }),
  }),
  middleware: provenance,
});

// A correlation id groups this request's calls into one logical chain.
const { text } = await generateText({
  model,
  prompt: "Why anchor model calls?",
  providerOptions: { ario: { chainKey: "example-request-1" } },
});
console.log("model said:", text, "\n");

const receipts = await provenance.close();
console.log(`${receipts.length} events → 1 checkpoint: ${receipts[0].gatewayUrl}\n`);

// Serialize the whole trace into ONE signed, portable, self-verifying bundle.
// An auditor verifies it offline with one command — no write SDK required.
const bundle = await toEvidenceBundle(receipts, {
  signer,
  issuer: { kind: "producer", producer_id: "example-06" },
});
await writeFile("trace-bundle.json", JSON.stringify(bundle, null, 2));

console.log("wrote trace-bundle.json — verify it yourself with the read-only kernel:\n");
console.log("  npx @ar.io/proof verify trace-bundle.json");
console.log("  # also confirm each checkpoint is anchored on-chain:");
console.log("  npx @ar.io/proof verify trace-bundle.json https://arweave.net,https://permagate.io\n");
console.log("(implemented on main; live once @ar.io/anchor and @ar.io/proof publish their next versions)");
