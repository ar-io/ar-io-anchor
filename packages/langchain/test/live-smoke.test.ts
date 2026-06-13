// Gated live smoke (PRD testing seam 8): one REAL dev-mode run — a
// FakeListChatModel invocation anchored through the batcher to the Turbo
// free tier. Never runs in CI — explicitly enabled via ANCHOR_LIVE_SMOKE=1.
// Anchors a real short chain: several callback events → ONE real checkpoint
// upload → per-event inclusion receipts against a real Arweave TX ID.

import { createAnchorer } from "@ar.io/anchor";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { describe, expect, it } from "vitest";

import { anchorCallbacks } from "../src/index";

const TXID_RE = /^[A-Za-z0-9_-]{43}$/;

describe.skipIf(process.env.ANCHOR_LIVE_SMOKE !== "1")("live smoke (Turbo free tier)", () => {
  it("anchors a real chat-model run as one batched checkpoint", { timeout: 120_000 }, async () => {
    const anchorer = createAnchorer(); // zero-config dev mode, real TurboUploader
    const provenance = anchorCallbacks(anchorer, {
      batch: { maxEvents: 16, maxAge: 30_000, name: "langchain-live-smoke" },
    });

    const model = new FakeListChatModel({ responses: ["anchored, for real this time"] });
    await model.invoke(`live smoke ${new Date().toISOString()}`, { callbacks: [provenance] });

    const receipts = await provenance.close();
    expect(receipts.length).toBeGreaterThanOrEqual(2); // chat_model_start + llm_end

    const txIds = new Set(receipts.map((r) => r.checkpointTxId));
    expect(txIds.size).toBe(1); // the whole run = ONE Arweave write
    const txId = [...txIds][0]!;
    expect(txId).toMatch(TXID_RE);

    for (const r of receipts) {
      expect(r.environment).toBe("dev");
      expect(r.auditPath).toBeDefined();
      expect(r.gatewayUrl).toContain(txId);
    }
    console.log(`live checkpoint: ${receipts[0]!.gatewayUrl} (${receipts.length} events)`);
  });
});
