// Proof retention (T9 Phase 1 — the `Sink` seam). Exercises the four
// acceptance sketches from feature-request-receipt-sink.md:
//   1. batch of N + FsSink → N event rows + 1 checkpoint row, each re-verifies
//      (verifyEnvelope + inclusion against the checkpoint row);
//   2. writeIntent + a crash between add() and flush → intent rows, no proof
//      rows, and the intent-minus-proof delta is exactly the lost window;
//   3. a sink that throws on every write → all receipts still resolve, the
//      committed record bytes are byte-identical to a no-sink run, plus warns;
//   4. no sink configured → no writes, receipts unchanged.
// Plus: the eventId-at-add() join key is stable end-to-end, single-shot
// anchor() emits a direct-proof row, and CallbackSink funnels every kind.
//
// Network-free: a stub Uploader derives the txId from the real data-item bytes
// (mirrors batch.test.ts / anchorer.test.ts seam 4); envelopes, signatures,
// and Merkle proofs are genuine.

import { bytesToHex, hexToBytes, verifyEnvelope, verifyInclusion } from "@ar.io/proof";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createAnchorer } from "../src/anchorer";
import { txIdFromDataItem } from "../src/dataitem";
import {
  CallbackSink,
  FsSink,
  type RetainedCheckpoint,
  type RetainedEvent,
  type Sink,
  type SinkRecord,
} from "../src/sink";
import type { UploadReceipt, Uploader } from "../src/turbo";

// --- shared network-free harness (same shape as batch.test.ts) -------------

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
}

class StubUploader implements Uploader {
  readonly items: Uint8Array[] = [];
  async upload(dataItem: Uint8Array): Promise<UploadReceipt> {
    this.items.push(dataItem);
    return { txId: await txIdFromDataItem(dataItem), raw: {} };
  }
}

function setup(sink?: Sink, warn: (m: string) => void = () => {}) {
  const clock = new FakeClock();
  const uploader = new StubUploader();
  const anchorer = createAnchorer({
    uploader,
    warn,
    timers: clock.timers_api,
    ...(sink !== undefined ? { sink } : {}),
  });
  return { clock, uploader, anchorer };
}

// A sink that funnels every write kind into an array (via CallbackSink).
function recordingSink(): { sink: Sink; records: SinkRecord[] } {
  const records: SinkRecord[] = [];
  return { sink: new CallbackSink((r) => void records.push(r)), records };
}

// A sink that throws on every method (failure-isolation probe).
class ThrowingSink implements Sink {
  async writeIntent(): Promise<void> {
    throw new Error("sink down: intent");
  }
  async writeEvent(): Promise<void> {
    throw new Error("sink down: event");
  }
  async writeCheckpoint(): Promise<void> {
    throw new Error("sink down: checkpoint");
  }
}

// --- temp-file bookkeeping --------------------------------------------------

const tmpDirs: string[] = [];
function tmpJsonl(): string {
  const dir = mkdtempSync(join(tmpdir(), "ario-sink-"));
  tmpDirs.push(dir);
  return join(dir, "retention.jsonl");
}
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe("acceptance 1 — FsSink: N event rows + 1 checkpoint row, each re-verifiable", () => {
  it("persists per-event proof rows that verify (envelope + inclusion) against the checkpoint row", async () => {
    const path = tmpJsonl();
    const { anchorer } = setup(new FsSink(path));
    const batch = anchorer.batch({ maxEvents: 5 });
    const handles = ["a", "b", "c", "d", "e"].map((d, i) =>
      batch.add({ data: d, metadata: { i } }),
    );
    await Promise.all(handles.map((h) => h.receipt()));

    const rows = FsSink.read(path);
    const events = rows.flatMap((r) => (r.type === "event" ? [r.event] : []));
    const checkpoints = rows.flatMap((r) => (r.type === "checkpoint" ? [r.checkpoint] : []));

    expect(events.length).toBe(5);
    expect(checkpoints.length).toBe(1);
    const checkpoint = checkpoints[0]!;

    // Every event row rebuilds from disk and re-verifies end to end.
    const seenIndexes: number[] = [];
    for (const ev of events) {
      // (a) envelope + committed record bind.
      const result = await verifyEnvelope(ev.envelope, { payloadBytes: ev.recordBytes });
      expect(result.ok, `envelope ${ev.eventId}`).toBe(true);
      expect(result.payloadHashOk).toBe(true);
      expect(result.signatureOk).toBe(true);

      // (b) inclusion against the CHECKPOINT ROW's merkleRoot (not a value
      //     carried on the event itself) — the join is by checkpointTxId.
      if (ev.proof.kind !== "inclusion") throw new Error("expected an inclusion proof");
      expect(ev.proof.checkpointTxId).toBe(checkpoint.txId);
      expect(ev.proof.leafCount).toBe(5);
      const included = await verifyInclusion(
        hexToBytes(ev.proof.leafHash),
        ev.proof.leafIndex,
        ev.proof.leafCount,
        ev.proof.auditPath.map(hexToBytes),
        hexToBytes(checkpoint.merkleRoot),
      );
      expect(included, `inclusion leaf ${ev.proof.leafIndex}`).toBe(true);
      seenIndexes.push(ev.proof.leafIndex);
    }
    expect(seenIndexes.sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4]);

    // The checkpoint row itself is a genuine, verifiable envelope.
    const ckResult = await verifyEnvelope(checkpoint.envelope, {
      payloadBytes: checkpoint.recordBytes,
    });
    expect(ckResult.ok).toBe(true);
  });
});

describe("acceptance 2 — writeIntent: a crash between add() and flush leaves an exact work queue", () => {
  it("intent rows exist, proof rows do not, and intent-minus-proof enumerates the lost window", async () => {
    const path = tmpJsonl();
    const { anchorer, uploader } = setup(new FsSink(path));
    // maxEvents far above the burst: nothing flushes. We never close() —
    // this is the crash.
    const batch = anchorer.batch({ maxEvents: 1000 });
    const handles = ["one", "two", "three", "four"].map((d) => batch.add({ data: d }));

    // Nothing was anchored.
    expect(uploader.items.length).toBe(0);

    const rows = FsSink.read(path);
    const intents = rows.flatMap((r) => (r.type === "intent" ? [r.intent] : []));
    const events = rows.flatMap((r) => (r.type === "event" ? [r.event] : []));

    expect(intents.length).toBe(4);
    expect(events.length).toBe(0);

    // The synchronous handle.eventId is the durable join key, on disk already.
    const handleIds = handles.map((h) => h.eventId).sort();
    const intentIds = intents.map((i) => i.eventId).sort();
    expect(intentIds).toEqual(handleIds);
    expect(new Set(handleIds).size).toBe(4); // distinct, minted at add()

    // The recovery index: SELECT WHERE proof IS NULL.
    const proven = new Set(events.map((e) => e.eventId));
    const lost = intents.map((i) => i.eventId).filter((id) => !proven.has(id));
    expect(lost.sort()).toEqual(handleIds); // exactly the lost window
  });
});

describe("acceptance 3 — a sink that throws on every write never breaks anchoring", () => {
  it("all receipts resolve, committed record bytes are byte-identical to a no-sink run, plus warnings", async () => {
    const data = ["a", "b", "c"];

    // Reference run: no sink.
    const ref = setup();
    const refBatch = ref.anchorer.batch({ maxEvents: 3 });
    const refReceipts = await Promise.all(
      data.map((d) => refBatch.add({ data: d }).receipt()),
    );

    // Throwing sink: warnings captured; receipts must still resolve.
    const warnings: string[] = [];
    const thrown = setup(new ThrowingSink(), (m) => warnings.push(m));
    const batch = thrown.anchorer.batch({ maxEvents: 3 });
    const receipts = await Promise.all(data.map((d) => batch.add({ data: d }).receipt()));

    // Every receipt resolved and verifies green — unchanged from today.
    for (const r of receipts) {
      const result = await verifyEnvelope(r.envelope, { payloadBytes: r.recordBytes });
      expect(result.ok).toBe(true);
      const included = await verifyInclusion(
        hexToBytes(r.leafHash),
        r.leafIndex,
        r.leafCount,
        r.auditPath.map(hexToBytes),
        hexToBytes(r.root),
      );
      expect(included).toBe(true);
    }

    // Committed record bytes (the on-chain-committed external commitment) are
    // byte-identical with vs. without the sink — the sink is a pure side channel.
    expect(receipts.map((r) => bytesToHex(r.recordBytes))).toEqual(
      refReceipts.map((r) => bytesToHex(r.recordBytes)),
    );
    // Exactly one upload per window either way — the sink added no traffic.
    expect(thrown.uploader.items.length).toBe(ref.uploader.items.length);
    expect(thrown.uploader.items.length).toBe(1);

    // The failures degraded to warnings: intent (x3) + event (x3) + checkpoint (x1).
    expect(warnings.length).toBeGreaterThanOrEqual(7);
    expect(warnings.some((w) => w.includes("writeIntent"))).toBe(true);
    expect(warnings.some((w) => w.includes("writeEvent"))).toBe(true);
    expect(warnings.some((w) => w.includes("writeCheckpoint"))).toBe(true);
  });
});

describe("acceptance 4 — no sink configured: no writes, receipts unchanged", () => {
  it("record bytes match a sink run and the sink is invoked exactly when present", async () => {
    const data = ["x", "y"];

    // With a recording sink: proves the wiring fires the expected write shape.
    const { sink, records } = recordingSink();
    const withSink = setup(sink);
    const wsBatch = withSink.anchorer.batch({ maxEvents: 2 });
    const wsReceipts = await Promise.all(
      data.map((d) => wsBatch.add({ data: d }).receipt()),
    );
    expect(records.filter((r) => r.type === "intent").length).toBe(2);
    expect(records.filter((r) => r.type === "event").length).toBe(2);
    expect(records.filter((r) => r.type === "checkpoint").length).toBe(1);

    // With no sink: nothing to record, and the committed bytes are identical.
    const noSink = setup();
    const nsBatch = noSink.anchorer.batch({ maxEvents: 2 });
    const nsReceipts = await Promise.all(
      data.map((d) => nsBatch.add({ data: d }).receipt()),
    );
    expect(nsReceipts.map((r) => bytesToHex(r.recordBytes))).toEqual(
      wsReceipts.map((r) => bytesToHex(r.recordBytes)),
    );
    // eventId-at-add() works regardless of sink presence.
    expect(nsReceipts.every((r) => /^[0-9a-f-]{36}$/.test(r.eventId))).toBe(true);
  });
});

describe("eventId-at-add(): the join key is stable end to end", () => {
  it("handle.eventId (sync) === intent === proof-row === receipt eventId", async () => {
    const { sink, records } = recordingSink();
    const { anchorer } = setup(sink);
    const batch = anchorer.batch({ maxEvents: 1 });
    const handle = batch.add({ data: "join" });
    const idAtAdd = handle.eventId; // known synchronously, before flush
    expect(idAtAdd).toMatch(/^[0-9a-f-]{36}$/);

    const receipt = await handle.receipt();
    const intent = records.find((r) => r.type === "intent");
    const event = records.find((r) => r.type === "event");
    if (intent?.type !== "intent" || event?.type !== "event") {
      throw new Error("expected both an intent and an event record");
    }

    expect(intent.intent.eventId).toBe(idAtAdd);
    expect(event.event.eventId).toBe(idAtAdd);
    expect(receipt.eventId).toBe(idAtAdd);
    expect(receipt.envelope.event_id).toBe(idAtAdd);
  });

  it("honours a caller-supplied eventId as the join key", async () => {
    const { sink, records } = recordingSink();
    const { anchorer } = setup(sink);
    const id = "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a";
    const handle = anchorer.batch({ maxEvents: 1 }).add({ data: "x", eventId: id });
    expect(handle.eventId).toBe(id);
    await handle.receipt();
    const intent = records.find((r) => r.type === "intent");
    if (intent?.type !== "intent") throw new Error("no intent");
    expect(intent.intent.eventId).toBe(id);
  });
});

describe("single-shot anchor(): one direct-proof event row, no intent/checkpoint", () => {
  it("writes a RetainedEvent with a direct proof after upload acceptance", async () => {
    const { sink, records } = recordingSink();
    const { anchorer } = setup(sink);
    const receipt = await anchorer.anchor({ data: "single", ref: "s3://b/k" });

    expect(records.filter((r) => r.type === "intent").length).toBe(0);
    expect(records.filter((r) => r.type === "checkpoint").length).toBe(0);
    const eventRecords = records.flatMap((r) => (r.type === "event" ? [r.event] : []));
    expect(eventRecords.length).toBe(1);

    const ev = eventRecords[0]!;
    expect(ev.eventId).toBe(receipt.eventId);
    expect(ev.ref).toBe("s3://b/k");
    if (ev.proof.kind !== "direct") throw new Error("expected a direct proof");
    expect(ev.proof.txId).toBe(receipt.txId);
    expect(ev.proof.gatewayUrl).toBe(receipt.gatewayUrl);

    const result = await verifyEnvelope(ev.envelope, { payloadBytes: ev.recordBytes });
    expect(result.ok).toBe(true);
  });

  it("emits no proof row when the upload is rejected (upload-then-sink)", async () => {
    const records: SinkRecord[] = [];
    const sink = new CallbackSink((r) => void records.push(r));
    // A lying uploader → TxIdMismatch upstream of the sink write.
    const anchorer = createAnchorer({
      uploader: { upload: async () => ({ txId: "WRONG", raw: {} }) },
      warn: () => {},
      sink,
    });
    await expect(anchorer.anchor({ data: "x" })).rejects.toThrow();
    expect(records.length).toBe(0); // never emit a proof for an unaccepted tx
  });
});

describe("CallbackSink funnels every write kind", () => {
  it("routes intent, event, and checkpoint into one function", async () => {
    const seen: SinkRecord["type"][] = [];
    const sink = new CallbackSink((r: SinkRecord) => {
      seen.push(r.type);
    });
    const { anchorer } = setup(sink);
    const batch = anchorer.batch({ maxEvents: 2 });
    await Promise.all(
      ["e0", "e1"].map((d) => batch.add({ data: d }).receipt()),
    );
    expect(seen.filter((t) => t === "intent").length).toBe(2);
    expect(seen.filter((t) => t === "event").length).toBe(2);
    expect(seen.filter((t) => t === "checkpoint").length).toBe(1);
  });
});

describe("RetainedEvent / RetainedCheckpoint typing sanity", () => {
  it("exposes the union proof variants", () => {
    const direct: RetainedEvent["proof"] = {
      kind: "direct",
      txId: "t",
      gatewayUrl: "g",
    };
    const inclusion: RetainedEvent["proof"] = {
      kind: "inclusion",
      leafHash: "lh",
      leafIndex: 0,
      leafCount: 1,
      auditPath: [],
      checkpointTxId: "c",
    };
    const ck: RetainedCheckpoint = {
      txId: "t",
      envelope: {} as RetainedCheckpoint["envelope"],
      recordBytes: new Uint8Array(),
      merkleRoot: "r",
      gatewayUrl: "g",
    };
    expect(direct.kind).toBe("direct");
    expect(inclusion.kind).toBe("inclusion");
    expect(ck.merkleRoot).toBe("r");
  });
});

describe("FsSink.read — crash resilience (torn trailing line)", () => {
  it("drops a torn trailing line (crash mid-append) and still returns the complete rows", async () => {
    const path = tmpJsonl();
    const { anchorer } = setup(new FsSink(path));
    const batch = anchorer.batch({ maxEvents: 2 });
    await Promise.all(["a", "b"].map((d) => batch.add({ data: d }).receipt()));
    const complete = FsSink.read(path).length;
    expect(complete).toBeGreaterThan(0);

    // Simulate a crash mid-append: a half-written, unparseable trailing line
    // (appendFileSync is not crash-atomic).
    appendFileSync(path, '{"type":"event","eventId":"torn","contentHa');

    // read() tolerates it — the torn line is dropped, every complete row survives.
    expect(FsSink.read(path).length).toBe(complete);
  });

  it("throws on a malformed line that is NOT the trailing line (real corruption)", () => {
    const path = tmpJsonl();
    // A garbage line with another line after it is mid-file corruption, not a
    // torn append — surface it rather than silently skipping durable rows.
    writeFileSync(path, "not-json-at-all\n{}\n");
    expect(() => FsSink.read(path)).toThrow();
  });
});
