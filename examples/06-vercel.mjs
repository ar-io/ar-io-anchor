// Anchor Vercel AI SDK calls: one middleware, a request's calls batched into
// ONE Arweave write, each call individually inclusion-proofed and offline-
// verified. Uses MockLanguageModelV3 so the example needs no LLM key — swap
// in any real model (openai("gpt-4o"), etc.); the middleware doesn't change.
//
// Makes one real free-tier Turbo write (dev mode), like examples 01/02/04/05.
import { createAnchorer } from "@ar.io/anchor";
import { hexToBytes, sha256Hex, verifyEnvelope, verifyInclusion } from "@ar.io/proof";
import { generateText, wrapLanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";

import { anchorMiddleware } from "@ar.io/anchor-vercel";

const ario = createAnchorer(); // dev mode: zero config, Turbo free tier
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

for (const r of receipts) {
  const m = JSON.parse(new TextDecoder().decode(r.recordBytes)).metadata.vercel_ai;
  const bindingOk = (await sha256Hex(r.recordBytes)) === r.envelope.payload_hash;
  const { signatureOk } = await verifyEnvelope(r.envelope);
  const inclusionOk = await verifyInclusion(
    hexToBytes(r.leafHash),
    r.leafIndex,
    r.leafCount,
    r.auditPath.map(hexToBytes),
    hexToBytes(r.root),
  );
  console.log(
    `leaf ${r.leafIndex}/${r.leafCount}  chain ${m.chain_key}  seq ${m.seq}`,
    `binding=${bindingOk} signature=${signatureOk} inclusion=${inclusionOk}`,
  );
}
console.log("\nRetain each receipt's recordBytes — that is what the hash commits to.");
