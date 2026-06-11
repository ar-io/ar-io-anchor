import { leafHash, verifyInclusion } from "@ar.io/proof";
import { describe, expect, it } from "vitest";

import { createAnchorer } from "../src/anchorer";
import { txIdFromDataItem } from "../src/dataitem";
import type { UploadReceipt, Uploader } from "../src/turbo";

// Fake clock (PRD testing seam 7): batcher timer logic tested as pure logic.
class FakeClock {
  private t = 0;
  private nextId = 1;
  private timers = new Map<number, { at: number; fn: () => void }>();

  readonly timers_api = {
    setTimeout: (fn: () => void, ms: number): unknown => {
      const id = this.nextId++;
      this.timers.set(id, { at: this.t + ms, fn });
      return id;
    },
    clearTimeout: (handle: unknown): void => {
      this.timers.delete(handle as number);
    },
    now: (): number => this.t,
  };

  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.t = due[1].at;
      this.timers.delete(due[0]);
      due[1].fn();
      // Let the async flush the timer kicked off make progress.
      await settle();
    }
    this.t = target;
    await settle();
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

class StubUploader implements Uploader {
  readonly items: Uint8Array[] = [];
  failNext = 0;
  async upload(dataItem: Uint8Array): Promise<UploadReceipt> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("stub upstream down");
    }
    this.items.push(dataItem);
    return { txId: await txIdFromDataItem(dataItem), raw: {} };
  }
}

function setup() {
  const clock = new FakeClock();
  const uploader = new StubUploader();
  const anchorer = createAnchorer({
    uploader,
    warn: () => {},
    timers: clock.timers_api,
  });
  return { clock, uploader, anchorer };
}

function recordOf(bytes: Uint8Array): Record<string, any> {
  return JSON.parse(new TextDecoder().decode(bytes));
}

describe("batch triggers", () => {
  it("maxEvents: flushes exactly at the threshold — one upload per window", async () => {
    const { uploader, anchorer } = setup();
    const batch = anchorer.batch({ maxEvents: 3 });
    const handles = [
      batch.add({ data: "e0" }),
      batch.add({ data: "e1" }),
      batch.add({ data: "e2" }),
    ];
    const receipts = await Promise.all(handles.map((h) => h.receipt()));

    expect(uploader.items.length).toBe(1);
    expect(receipts.map((r) => r.leafIndex)).toEqual([0, 1, 2]);
    expect(new Set(receipts.map((r) => r.checkpointTxId)).size).toBe(1);
    expect(receipts[0]!.leafCount).toBe(3);
  });

  it("maxAge: wall-clock from the FIRST event; a partial batch (of one) flushes", async () => {
    const { clock, uploader, anchorer } = setup();
    const batch = anchorer.batch({ maxAge: 1000 });
    const handle = batch.add({ data: "lonely" });

    await clock.advance(999);
    expect(uploader.items.length).toBe(0);
    await clock.advance(1);
    const receipt = await handle.receipt();

    expect(uploader.items.length).toBe(1);
    expect(receipt.leafCount).toBe(1);
    expect(receipt.auditPath).toEqual([]);
    expect(receipt.root).toBe(receipt.leafHash); // single-leaf tree
  });

  it("flushOnIdle: resets on every add, fires after the burst stops", async () => {
    const { clock, uploader, anchorer } = setup();
    const batch = anchorer.batch({ flushOnIdle: 500 });

    const h1 = batch.add({ data: "a" });
    await clock.advance(400);
    expect(uploader.items.length).toBe(0);
    const h2 = batch.add({ data: "b" }); // resets the idle timer
    await clock.advance(400);
    expect(uploader.items.length).toBe(0);
    await clock.advance(100); // 500ms idle reached
    const [r1, r2] = await Promise.all([h1.receipt(), h2.receipt()]);

    expect(uploader.items.length).toBe(1);
    expect(r1.leafCount).toBe(2);
    expect(r1.checkpointTxId).toBe(r2.checkpointTxId);
  });

  it("first trigger wins: maxAge fires before maxEvents is reached", async () => {
    const { clock, uploader, anchorer } = setup();
    const batch = anchorer.batch({ maxEvents: 5, maxAge: 1000 });
    const h1 = batch.add({ data: "a" });
    batch.add({ data: "b" });

    await clock.advance(1000);
    const r1 = await h1.receipt();
    expect(r1.leafCount).toBe(2);
    expect(uploader.items.length).toBe(1);

    // Next window starts fresh — its maxAge anchors to ITS first event.
    const h3 = batch.add({ data: "c" });
    await clock.advance(1000);
    const r3 = await h3.receipt();
    expect(r3.leafCount).toBe(1);
    expect(uploader.items.length).toBe(2);
  });

  it("requires at least one trigger and validates maxEvents", () => {
    const { anchorer } = setup();
    expect(() => anchorer.batch({})).toThrow(/at least one/);
    expect(() => anchorer.batch({ maxEvents: 0 })).toThrow(/positive/);
  });
});

describe("close()", () => {
  it("flushes buffered events; add() after close throws; anchorer.close() closes all", async () => {
    const { uploader, anchorer } = setup();
    const batch = anchorer.batch({ maxEvents: 100 });
    const handle = batch.add({ data: "pending" });

    await anchorer.close();
    const receipt = await handle.receipt();
    expect(receipt.leafCount).toBe(1);
    expect(uploader.items.length).toBe(1);
    expect(() => batch.add({ data: "late" })).toThrow(/closed/);
  });

  it("close on an empty batch uploads nothing", async () => {
    const { uploader, anchorer } = setup();
    anchorer.batch({ maxEvents: 10 });
    await anchorer.close();
    expect(uploader.items.length).toBe(0);
  });
});

describe("checkpoints & inclusion proofs", () => {
  it("receipts verify offline via @ar.io/proof and match the checkpoint record", async () => {
    const { anchorer } = setup();
    const batch = anchorer.batch({ maxEvents: 5 });
    const handles = ["a", "b", "c", "d", "e"].map((d) =>
      batch.add({ data: d, metadata: { i: d } }),
    );
    const receipts = await Promise.all(handles.map((h) => h.receipt()));

    for (const r of receipts) {
      // Leaf hash recomputes from the signed envelope bytes (profile §6).
      const lh = await leafHash(r.envelopeBytes);
      expect(Buffer.from(lh).toString("hex")).toBe(r.leafHash);
      // Inclusion proof verifies against the root.
      const ok = await verifyInclusion(
        lh,
        r.leafIndex,
        r.leafCount,
        r.auditPath.map((h) => Uint8Array.from(Buffer.from(h, "hex"))),
        Uint8Array.from(Buffer.from(r.root, "hex")),
      );
      expect(ok, `leaf ${r.leafIndex}`).toBe(true);
      // The checkpoint record commits to that root.
      const ckRecord = recordOf(r.checkpointRecordBytes);
      expect(ckRecord.event.merkle_root).toBe(r.root);
      expect(ckRecord.event.leaf_count).toBe(5);
      expect(ckRecord.event_type).toBe("checkpoint");
      expect(r.checkpointEnvelope.payload_hash).toBeDefined();
    }
  });

  it("chains checkpoints per batcher: GENESIS, then previous checkpoint's record hash", async () => {
    const { anchorer } = setup();
    const batch = anchorer.batch({ maxEvents: 1, name: "demo" });
    const r1 = await batch.add({ data: "w1" }).receipt();
    const r2 = await batch.add({ data: "w2" }).receipt();

    const ck1 = recordOf(r1.checkpointRecordBytes);
    const ck2 = recordOf(r2.checkpointRecordBytes);
    expect(ck1.previous_hash).toBe("GENESIS");
    expect(ck1.context.chain_key).toBe("batcher:demo");
    expect(ck2.previous_hash).toBe(r1.checkpointEnvelope.payload_hash);
  });

  it("leaf records carry metadata/eventId and leaf envelopes are unchained", async () => {
    const { anchorer } = setup();
    const batch = anchorer.batch({ maxEvents: 1 });
    const id = "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a";
    const r = await batch.add({ data: "x", eventId: id, metadata: { k: "v" } }).receipt();

    expect(r.eventId).toBe(id);
    expect(r.envelope.event_id).toBe(id);
    const record = recordOf(r.recordBytes);
    expect(record.metadata).toEqual({ k: "v" });
    expect(record.previous_hash).toBe("GENESIS");
    expect(r.envelope.environment).toBe("dev");
  });
});

describe("failure semantics", () => {
  it("a failed window rejects its receipts; the next window proceeds without burning the chain", async () => {
    const { uploader, anchorer } = setup();
    const batch = anchorer.batch({ maxEvents: 2, name: "f" });
    uploader.failNext = 1;

    const h1 = batch.add({ data: "a" });
    const h2 = batch.add({ data: "b" });
    await expect(h1.receipt()).rejects.toThrow(/stub upstream down/);
    await expect(h2.receipt()).rejects.toThrow(/stub upstream down/);
    expect(uploader.items.length).toBe(0);

    const h3 = batch.add({ data: "c" });
    batch.add({ data: "d" }); // fills the window → triggers the flush
    const r = await h3.receipt();
    // Failed window never advanced the head — this checkpoint is GENESIS.
    expect(recordOf(r.checkpointRecordBytes).previous_hash).toBe("GENESIS");
    expect(uploader.items.length).toBe(1);
  });

  it("validates add() inputs", () => {
    const { anchorer } = setup();
    const batch = anchorer.batch({ maxEvents: 10 });
    expect(() => batch.add({})).toThrow(/exactly one/);
    expect(() => batch.add({ data: "x", contentHash: "a".repeat(64) })).toThrow(
      /exactly one/,
    );
    expect(() => batch.add({ contentHash: "nope" })).toThrow(/sha256/);
  });
});
