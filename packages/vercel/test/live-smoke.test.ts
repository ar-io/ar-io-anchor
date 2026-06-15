// Gated live smoke (PRD testing seam 8): one REAL dev-mode run — a
// MockLanguageModelV3 generateText anchored through the batcher to the Turbo
// free tier. Never runs in CI — explicitly enabled via ANCHOR_LIVE_SMOKE=1.
// Anchors a real short chain: generate_start + generate_end → ONE real
// checkpoint upload → per-event inclusion receipts against a real TX ID.

import { createAnchorer } from "@ar.io/anchor";
import { generateText, wrapLanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";

import { anchorMiddleware } from "../src/index";

const TXID_RE = /^[A-Za-z0-9_-]{43}$/;

describe.skipIf(process.env.ANCHOR_LIVE_SMOKE !== "1")("live smoke (Turbo free tier)", () => {
  it("anchors a real generateText call as one batched checkpoint", { timeout: 120_000 }, async () => {
    const anchorer = createAnchorer(); // zero-config dev mode, real TurboUploader
    const provenance = anchorMiddleware(anchorer, {
      batch: { maxEvents: 16, maxAge: 30_000, name: "vercel-live-smoke" },
    });

    const model = wrapLanguageModel({
      model: new MockLanguageModelV3({
        doGenerate: async () => ({
          finishReason: "stop",
          usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
          content: [{ type: "text", text: "anchored, for real" }],
          warnings: [],
        }) as never,
      }),
      middleware: provenance,
    });

    await generateText({
      model,
      prompt: `live smoke ${new Date().toISOString()}`,
      providerOptions: { ario: { chainKey: "live-smoke-run" } },
    });

    const receipts = await provenance.close();
    expect(receipts.length).toBe(2); // generate_start + generate_end

    const txIds = new Set(receipts.map((r) => r.checkpointTxId));
    expect(txIds.size).toBe(1); // the whole call = ONE Arweave write
    const txId = [...txIds][0]!;
    expect(txId).toMatch(TXID_RE);

    for (const r of receipts) {
      expect(r.environment).toBe("dev");
      expect(r.gatewayUrl).toContain(txId);
    }
    console.log(`live checkpoint: ${receipts[0]!.gatewayUrl} (${receipts.length} events)`);
  });
});
