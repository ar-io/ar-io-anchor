// Gated live smoke (PRD testing seam 8): one REAL dev-mode anchor against
// the Turbo free tier. Never runs in CI — explicitly enabled via
// ANCHOR_LIVE_SMOKE=1. The upload-acceptance witness point (Turbo returned
// a tx id for our hand-rolled data item) is the strongest possible
// validation of the wire format: the real upstream re-derives the deep hash
// from our bytes and verifies our signature before accepting.

import { describe, expect, it } from "vitest";

import { createAnchorer } from "../src/anchorer";

describe.skipIf(process.env.ANCHOR_LIVE_SMOKE !== "1")("live smoke (Turbo free tier)", () => {
  it("anchors a dev-mode envelope end-to-end", { timeout: 120_000 }, async () => {
    const anchorer = createAnchorer(); // zero-config dev mode, real TurboUploader
    const receipt = await anchorer.anchor({
      type: "event",
      data: `ar-io-anchor live smoke ${new Date().toISOString()}`,
      metadata: { suite: "live-smoke" },
    });

    expect(receipt.txId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(receipt.environment).toBe("dev");
    expect(receipt.envelope.environment).toBe("dev");

    // eslint-disable-next-line no-console
    console.log(
      `live smoke anchored: ${receipt.explorerUrl} (event ${receipt.eventId}, ` +
        `payload_hash ${receipt.payloadHash})`,
    );
  });

  it("batches three events into one live checkpoint", { timeout: 120_000 }, async () => {
    const anchorer = createAnchorer();
    const batch = anchorer.batch({ maxEvents: 3, name: "live-smoke" });
    const stamp = new Date().toISOString();
    const receipts = await Promise.all(
      [0, 1, 2].map((i) =>
        batch.add({ data: `live batch event ${i} ${stamp}` }).receipt(),
      ),
    );
    await anchorer.close();

    expect(new Set(receipts.map((r) => r.checkpointTxId)).size).toBe(1);
    expect(receipts.map((r) => r.leafIndex)).toEqual([0, 1, 2]);

    // eslint-disable-next-line no-console
    console.log(
      `live checkpoint anchored: ${receipts[0]!.explorerUrl} ` +
        `(root ${receipts[0]!.root}, ${receipts[0]!.leafCount} leaves)`,
    );
  });
});
