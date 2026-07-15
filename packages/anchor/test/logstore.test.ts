// Content retention (T9 Phase 2 — the `LogStore` seam). Exercises the five
// acceptance sketches from feature-request-logstore-ingestion.md:
//   1. core batch + FsLogStore + FsSink → end-to-end from STORED ARTIFACTS
//      ONLY: for every event sha256(logStore.get(eventId)) ===
//      record.event.content_hash, verifyEnvelope(envelope,{payloadBytes:
//      recordBytes}) passes, and inclusion walks to the checkpoint root;
//   2. a customer-side re-serialization (key reorder) fails the hash
//      comparison while the logStore copy passes — the eliminated bug class;
//   3. put() returning a ref → that ref rides INSIDE the signed record
//      (visible in recordBytes) + envelope.payload_ref, and a bundle built
//      with auto-disclosure from logStore.get() verifies self-contained
//      through the @ar.io/proof verify path; caller-supplied ref wins;
//   4. strict mode fails a put()-failed event LOUDLY + enumerably (never
//      silent, never a crash), best-effort anchors with contentStored:false;
//   5. no logStore configured → byte-identical to today, no content writes.
//
// Network-free: a stub Uploader derives the txId from the real data-item bytes
// (mirrors sink.test.ts / batch.test.ts seam 4); envelopes, signatures, and
// Merkle proofs are genuine. The bundle is verified with the SHIPPING
// @ar.io/proof kernel only (verifyEnvelope + verifyInclusion + ed25519Verify +
// jcs), i.e. what `npx @ar.io/proof verify` runs — an auditor needs no write SDK.

import {
  bytesToHex,
  ed25519Verify,
  hexToBytes,
  jcs,
  sha256Hex,
  utf8,
  verifyEnvelope,
  verifyInclusion,
} from "@ar.io/proof";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createAnchorer } from "../src/anchorer";
import { txIdFromDataItem } from "../src/dataitem";
import { RetentionError } from "../src/errors";
import type { EvidenceBundle } from "../src/evidence";
import { CallbackLogStore, FsLogStore, type LogStore, type StoredContent } from "../src/logstore";
import { CallbackSink, FsSink, type SinkRecord } from "../src/sink";
import type { UploadReceipt, Uploader } from "../src/turbo";

// --- shared network-free harness -------------------------------------------

class StubUploader implements Uploader {
  readonly items: Uint8Array[] = [];
  async upload(dataItem: Uint8Array): Promise<UploadReceipt> {
    this.items.push(dataItem);
    return { txId: await txIdFromDataItem(dataItem), raw: {} };
  }
}

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ario-logstore-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function recordingSink(): { sink: CallbackSink; records: SinkRecord[] } {
  const records: SinkRecord[] = [];
  return { sink: new CallbackSink((r) => void records.push(r)), records };
}

function contentHashOf(recordBytes: Uint8Array): string {
  const record = JSON.parse(new TextDecoder().decode(recordBytes)) as {
    event: { content_hash: string; ref?: string };
  };
  return record.event.content_hash;
}
function refOf(recordBytes: Uint8Array): string | undefined {
  const record = JSON.parse(new TextDecoder().decode(recordBytes)) as {
    event: { ref?: string };
  };
  return record.event.ref;
}

// A faithful re-implementation of the @ar.io/proof verify algorithm over an
// evidence bundle (mirrors evidence.test.ts's verifyBundleWithKernel), plus a
// disclosed-content binding check so "self-contained" is actually proven: an
// auditor with ONLY the bundle can hash the embedded bytes and confirm they
// bind to the on-chain-committed content_hash.
async function verifyBundleSelfContained(bundle: EvidenceBundle): Promise<{
  signatureOk: boolean;
  bodyHashOk: boolean;
  checkpointsOk: boolean;
  eventsOk: boolean;
  disclosedContentOk: boolean;
}> {
  const { signature, ...preSig } = bundle;
  const signatureOk = await ed25519Verify(signature, utf8(jcs(preSig)), bundle.public_key);
  const bodyHashOk = (await sha256Hex(utf8(jcs(bundle.body)))) === bundle.body_hash;

  const byTx = new Map(bundle.body.checkpoints.map((c) => [c.tx_id, c]));
  let checkpointsOk = bundle.body.checkpoints.length > 0;
  for (const cp of bundle.body.checkpoints) {
    const res = await verifyEnvelope(cp.envelope, { payloadBytes: hexToBytes(cp.record_bytes) });
    if (!(res.ok && res.payloadHashOk === true)) checkpointsOk = false;
  }

  let eventsOk = true;
  let disclosedContentOk = true;
  for (const ev of bundle.body.events) {
    const res = await verifyEnvelope(
      ev.envelope,
      ev.record_bytes !== undefined ? { payloadBytes: hexToBytes(ev.record_bytes) } : {},
    );
    const cp = byTx.get(ev.inclusion.checkpoint_tx_id);
    const inclOk = cp
      ? await verifyInclusion(
          hexToBytes(ev.inclusion.leaf_hash),
          ev.inclusion.leaf_index,
          ev.inclusion.leaf_count,
          ev.inclusion.audit_path.map(hexToBytes),
          hexToBytes(cp.merkle_root),
        )
      : false;
    if (!(res.ok && inclOk)) eventsOk = false;
    // Self-contained: the embedded raw bytes hash to the committed content_hash.
    if (ev.content !== undefined) {
      const committed = contentHashOf(hexToBytes(ev.record_bytes!));
      if ((await sha256Hex(hexToBytes(ev.content))) !== committed) disclosedContentOk = false;
    }
  }
  return { signatureOk, bodyHashOk, checkpointsOk, eventsOk, disclosedContentOk };
}

// ---------------------------------------------------------------------------

describe("sketch 1 — end-to-end from stored artifacts only (FsLogStore + FsSink)", () => {
  it("every event: sha256(logStore.get) === committed content_hash, envelope + inclusion verify", async () => {
    const dir = tmpDir();
    const logStore = new FsLogStore(join(dir, "content-store"));
    const sinkPath = join(dir, "proofs.jsonl");
    const anchorer = createAnchorer({
      uploader: new StubUploader(),
      warn: () => {},
      logStore,
      sink: new FsSink(sinkPath),
    });

    const batch = anchorer.batch({ maxEvents: 5 });
    const payloads = ["alpha", "beta", "gamma", "delta", "epsilon"];
    await Promise.all(payloads.map((d, i) => batch.add({ data: d, metadata: { i } }).receipt()));

    // From this point on, ALL state comes off disk — no in-memory receipts.
    const rows = FsSink.read(sinkPath);
    const events = rows.flatMap((r) => (r.type === "event" ? [r.event] : []));
    const checkpoint = rows.flatMap((r) => (r.type === "checkpoint" ? [r.checkpoint] : []))[0]!;
    expect(events.length).toBe(5);
    expect(checkpoint).toBeDefined();

    for (const ev of events) {
      // (a) content retention: the stored bytes hash to the committed hash.
      const stored = await logStore.get(ev.eventId);
      expect(stored, `logStore.get(${ev.eventId})`).not.toBeNull();
      expect(await sha256Hex(stored!)).toBe(contentHashOf(ev.recordBytes));

      // (b) envelope binds to its committed record.
      const envResult = await verifyEnvelope(ev.envelope, { payloadBytes: ev.recordBytes });
      expect(envResult.ok, `envelope ${ev.eventId}`).toBe(true);
      expect(envResult.payloadHashOk).toBe(true);

      // (c) inclusion walks to the checkpoint root.
      if (ev.proof.kind !== "inclusion") throw new Error("expected inclusion proof");
      const included = await verifyInclusion(
        hexToBytes(ev.proof.leafHash),
        ev.proof.leafIndex,
        ev.proof.leafCount,
        ev.proof.auditPath.map(hexToBytes),
        hexToBytes(checkpoint.merkleRoot),
      );
      expect(included, `inclusion ${ev.eventId}`).toBe(true);
    }
  });
});

describe("sketch 2 — a customer re-serialization (key reorder) fails the hash; the logStore copy passes", () => {
  it("reordered JSON does not match content_hash, but the stored bytes do", async () => {
    const dir = tmpDir();
    const logStore = new FsLogStore(join(dir, "cas"));
    const anchorer = createAnchorer({ uploader: new StubUploader(), warn: () => {}, logStore });

    // The SDK commits the exact bytes handed to add(): JSON.stringify({a,b}).
    const canonical = JSON.stringify({ a: 1, b: 2 });
    const receipt = await anchorer.batch({ maxEvents: 1 }).add({ data: canonical }).receipt();
    const committed = receipt.contentHash;

    // A customer independently re-serializing "the same" event with a different
    // key order persists DIFFERENT bytes → a different hash → a proof that can
    // never verify. This is the silent, audit-time-only failure the seam kills.
    const reordered = JSON.stringify({ b: 2, a: 1 });
    expect(reordered).not.toBe(canonical);
    expect(await sha256Hex(utf8(reordered))).not.toBe(committed);

    // The logStore copy is the exact committed bytes — it always passes.
    const stored = await logStore.get(receipt.eventId);
    expect(new TextDecoder().decode(stored!)).toBe(canonical);
    expect(await sha256Hex(stored!)).toBe(committed);
    expect(receipt.contentStored).toBe(true);
  });
});

describe("sketch 3 — put() ref binds into the signed record; auto-disclosed bundle self-verifies", () => {
  it("the FsLogStore ref rides in recordBytes (event.ref) AND envelope.payload_ref", async () => {
    const dir = tmpDir();
    const logStore = new FsLogStore(join(dir, "cas"));
    const anchorer = createAnchorer({ uploader: new StubUploader(), warn: () => {}, logStore });

    const receipt = await anchorer.batch({ maxEvents: 1 }).add({ data: "bind-me" }).receipt();
    const storeRef = receipt.envelope.payload_ref;
    expect(storeRef).toMatch(/^file:\/\//); // content-addressed file:// locator
    // The SAME ref is inside the hash-committed record (visible in recordBytes).
    expect(refOf(receipt.recordBytes)).toBe(storeRef);
  });

  it("caller-supplied ref WINS; the logStore ref fills only when the caller left it empty", async () => {
    // A content-addressed CallbackLogStore ref (deterministic from contentHash).
    const logStore = new CallbackLogStore((c) => ({ ref: `cas:sha256:${c.contentHash}` }));
    const anchorer = createAnchorer({ uploader: new StubUploader(), warn: () => {}, logStore });
    const batch = anchorer.batch({ maxEvents: 2 });
    const withCaller = batch.add({ data: "x", ref: "s3://bucket/key" });
    const withoutCaller = batch.add({ data: "y" });
    const [rc, rn] = await Promise.all([withCaller.receipt(), withoutCaller.receipt()]);

    // Caller-supplied ref wins over the logStore ref (record + payload_ref).
    expect(refOf(rc.recordBytes)).toBe("s3://bucket/key");
    expect(rc.envelope.payload_ref).toBe("s3://bucket/key");
    // No caller ref → the content-addressed logStore ref fills.
    expect(refOf(rn.recordBytes)).toBe(`cas:sha256:${rn.contentHash}`);
    expect(rn.envelope.payload_ref).toBe(`cas:sha256:${rn.contentHash}`);
  });

  it("a bundle auto-disclosed from logStore.get() verifies self-contained via the @ar.io/proof path", async () => {
    const dir = tmpDir();
    const logStore = new FsLogStore(join(dir, "cas"));
    const anchorer = createAnchorer({ uploader: new StubUploader(), warn: () => {}, logStore });
    const batch = anchorer.batch({ maxEvents: 3 });
    const receipts = await Promise.all(
      ["one", "two", "three"].map((d) => batch.add({ data: d }).receipt()),
    );

    // Export composition (one-liner): fill `disclose` straight from the store.
    // The assembly-time assertion sha256(disclosed)===content_hash in
    // evidence.ts is now a GUARANTEED pass, not a hope.
    const disclose: Record<string, Uint8Array> = {};
    for (const r of receipts) {
      const bytes = await logStore.get(r.eventId);
      if (bytes) disclose[r.eventId] = bytes;
    }
    const bundle = await anchorer.bundle(receipts, { disclose });

    // Every event carries its raw bytes inside the signed body.
    for (const ev of bundle.body.events) expect(ev.content).toBeDefined();
    const v = await verifyBundleSelfContained(bundle);
    expect(v.signatureOk).toBe(true);
    expect(v.bodyHashOk).toBe(true);
    expect(v.checkpointsOk).toBe(true);
    expect(v.eventsOk).toBe(true);
    expect(v.disclosedContentOk).toBe(true); // embedded bytes bind to content_hash
  });
});

describe("sketch 4 — strict fails loudly + enumerably; best-effort flags contentStored:false", () => {
  // A store that rejects for one specific payload, succeeds otherwise.
  function poisonStore(poison: string): LogStore {
    return {
      async put(c: StoredContent) {
        if (new TextDecoder().decode(c.content) === poison) throw new Error("store unavailable");
      },
    };
  }

  it("strict (default): the put-failed event REJECTS with RetentionError, siblings still anchor", async () => {
    const uploader = new StubUploader();
    const { sink, records } = recordingSink();
    const anchorer = createAnchorer({
      uploader,
      warn: () => {},
      logStore: poisonStore("poison"),
      sink,
    });
    const batch = anchorer.batch({ maxEvents: 3 });
    const h1 = batch.add({ data: "ok-1" });
    const hp = batch.add({ data: "poison" });
    const h2 = batch.add({ data: "ok-2" });

    // Loud: the failed event's receipt rejects with a typed RetentionError.
    await expect(hp.receipt()).rejects.toBeInstanceOf(RetentionError);
    // Siblings anchored fine, flagged stored.
    const [r1, r2] = await Promise.all([h1.receipt(), h2.receipt()]);
    expect(r1.contentStored).toBe(true);
    expect(r2.contentStored).toBe(true);
    expect(r1.leafCount).toBe(2); // the poison leaf was excluded from the tree
    expect(await verifyEnvelope(r1.envelope, { payloadBytes: r1.recordBytes })).toMatchObject({
      ok: true,
    });

    // Not silent, not a crash — and ENUMERABLE via the sink: the poison event
    // has an intent row (written at add()) but never gets a proof row.
    await anchorer.close();
    const intents = records.flatMap((r) => (r.type === "intent" ? [r.intent] : []));
    const events = records.flatMap((r) => (r.type === "event" ? [r.event] : []));
    expect(intents.length).toBe(3);
    expect(events.length).toBe(2);
    const proven = new Set(events.map((e) => e.eventId));
    const lost = intents.map((i) => i.eventId).filter((id) => !proven.has(id));
    expect(lost).toEqual([hp.eventId]); // SELECT WHERE proof IS NULL == the poison event
    expect(uploader.items.length).toBe(1); // one checkpoint over the two survivors
  });

  it("best-effort (anchor-anyway-flag): the event anchors with contentStored:false + a warn", async () => {
    const warnings: string[] = [];
    const uploader = new StubUploader();
    const anchorer = createAnchorer({
      uploader,
      warn: (m) => warnings.push(m),
      logStore: poisonStore("poison"),
      onRetentionError: "anchor-anyway-flag",
    });
    const batch = anchorer.batch({ maxEvents: 2 });
    const [rok, rpoison] = await Promise.all([
      batch.add({ data: "fine" }).receipt(),
      batch.add({ data: "poison" }).receipt(),
    ]);

    expect(rok.contentStored).toBe(true);
    expect(rpoison.contentStored).toBe(false); // anchored despite the store failure
    expect(await verifyEnvelope(rpoison.envelope, { payloadBytes: rpoison.recordBytes })).toMatchObject(
      { ok: true },
    );
    expect(uploader.items.length).toBe(1); // both leaves anchored in one window
    expect(warnings.some((w) => w.includes("contentStored:false"))).toBe(true);
  });

  it("best-effort: contentStored survives to the DURABLE sink trace, not just the receipt", async () => {
    // The retention-truth flag MUST reach disk: a never-stored event's proof row
    // has to be distinguishable from a fully-retained one, else the durable trace
    // silently lies (the audit-time-only failure this seam exists to kill).
    // FsSink round-trips it through the full path: wiring → writeEvent →
    // JSON serialize → FsSink.read.
    const path = join(tmpDir(), "retention.jsonl");
    const anchorer = createAnchorer({
      uploader: new StubUploader(),
      warn: () => {},
      logStore: poisonStore("poison"),
      onRetentionError: "anchor-anyway-flag",
      sink: new FsSink(path),
    });
    const batch = anchorer.batch({ maxEvents: 2 });
    const [rok, rpoison] = await Promise.all([
      batch.add({ data: "fine" }).receipt(),
      batch.add({ data: "poison" }).receipt(),
    ]);

    const events = FsSink.read(path).flatMap((r) => (r.type === "event" ? [r.event] : []));
    const byId = new Map(events.map((e) => [e.eventId, e]));
    // The durable row agrees with the receipt — false for the never-stored event.
    expect(byId.get(rok.eventId)?.contentStored).toBe(true);
    expect(byId.get(rpoison.eventId)?.contentStored).toBe(false);
  });

  it("single-shot best-effort: the durable event row carries contentStored:false", async () => {
    const path = join(tmpDir(), "retention.jsonl");
    const anchorer = createAnchorer({
      uploader: new StubUploader(),
      warn: () => {},
      logStore: poisonStore("poison"),
      onRetentionError: "anchor-anyway-flag",
      sink: new FsSink(path),
    });
    const receipt = await anchorer.anchor({ data: "poison" });
    expect(receipt.contentStored).toBe(false);

    const events = FsSink.read(path).flatMap((r) => (r.type === "event" ? [r.event] : []));
    expect(events).toHaveLength(1);
    expect(events[0]?.contentStored).toBe(false);
  });

  it("single-shot strict rejects (nothing uploaded); best-effort returns contentStored:false", async () => {
    const strictUploader = new StubUploader();
    const strict = createAnchorer({
      uploader: strictUploader,
      warn: () => {},
      logStore: poisonStore("poison"),
    });
    await expect(strict.anchor({ data: "poison" })).rejects.toBeInstanceOf(RetentionError);
    expect(strictUploader.items.length).toBe(0); // store-before-anchor: never uploaded

    const beUploader = new StubUploader();
    const best = createAnchorer({
      uploader: beUploader,
      warn: () => {},
      logStore: poisonStore("poison"),
      onRetentionError: "anchor-anyway-flag",
    });
    const receipt = await best.anchor({ data: "poison" });
    expect(receipt.contentStored).toBe(false);
    expect(beUploader.items.length).toBe(1);
  });

  it("neither flush() nor close() ever throws, even when every put fails strictly", async () => {
    const anchorer = createAnchorer({
      uploader: new StubUploader(),
      warn: () => {},
      logStore: poisonStore("poison"),
    });
    const batch = anchorer.batch({ maxEvents: 5 });
    const handles = ["poison", "poison", "poison"].map((d) => batch.add({ data: d }));
    // The host shutdown path awaits close() unconditionally — it must resolve.
    await expect(anchorer.close()).resolves.toBeUndefined();
    for (const h of handles) await expect(h.receipt()).rejects.toBeInstanceOf(RetentionError);
  });
});

describe("sketch 5 — no logStore configured: byte-identical to today, no content writes", () => {
  it("record bytes match a no-store run; no payload_ref; no contentStored key", async () => {
    const data = ["p", "q"];
    const noStore = createAnchorer({ uploader: new StubUploader(), warn: () => {} });
    const nsReceipts = await Promise.all(
      data.map((d) => noStore.batch({ maxEvents: 1 }).add({ data: d }).receipt()),
    );
    for (const r of nsReceipts) {
      expect(r.envelope.payload_ref).toBeUndefined();
      expect("contentStored" in r).toBe(false); // key omitted entirely
    }

    // A logStore that stores but returns NO ref (void): content is retained,
    // but with no ref there is NO record/envelope format change → recordBytes
    // are byte-identical to the no-store run. Only the in-memory receipt flag
    // (contentStored) differs.
    const puts: string[] = [];
    const voidStore = new CallbackLogStore((c) => void puts.push(c.eventId));
    const withStore = createAnchorer({
      uploader: new StubUploader(),
      warn: () => {},
      logStore: voidStore,
    });
    const wsReceipts = await Promise.all(
      data.map((d) => withStore.batch({ maxEvents: 1 }).add({ data: d }).receipt()),
    );
    expect(wsReceipts.map((r) => bytesToHex(r.recordBytes))).toEqual(
      nsReceipts.map((r) => bytesToHex(r.recordBytes)),
    );
    for (const r of wsReceipts) {
      expect(r.envelope.payload_ref).toBeUndefined(); // no ref → no payload_ref
      expect(r.contentStored).toBe(true); // but content WAS retained
    }
    expect(puts.length).toBe(2); // put() fired once per event
  });

  it("a contentHash-only add (no bytes) engages no put and stays unflagged", async () => {
    const puts: StoredContent[] = [];
    const store = new CallbackLogStore((c) => void puts.push(c));
    const anchorer = createAnchorer({ uploader: new StubUploader(), warn: () => {}, logStore: store });
    const hash = await sha256Hex(utf8("precomputed"));
    const receipt = await anchorer.batch({ maxEvents: 1 }).add({ contentHash: hash }).receipt();
    expect(puts.length).toBe(0); // nothing to store — no bytes were provided
    expect("contentStored" in receipt).toBe(false);
  });
});
