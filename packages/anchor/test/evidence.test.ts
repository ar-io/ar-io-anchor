// Round-trip: anchor a small batch → toEvidenceBundle(receipts) → verify the
// resulting ario.evidence/v1 / ario.anchor.trace/v1 bundle end-to-end using the
// SHIPPING @ar.io/proof primitives (verifyEnvelope + verifyInclusion + jcs +
// ed25519Verify). Verifying the emitter's output with the published kernel —
// not the emitter's own code — is the conformance point: an auditor with only
// @ar.io/proof can verify the bundle. (The turnkey `verifyEvidenceBundle`
// helper / `npx @ar.io/proof verify` CLI run the identical algorithm; this test
// pins that the bytes the emitter produces are verifiable.)

import { bytesToHex, ed25519Verify, jcs, sha256Hex, utf8, verifyEnvelope, verifyInclusion } from "@ar.io/proof";
import { describe, expect, it } from "vitest";

import { createAnchorer } from "../src/anchorer";
import { txIdFromDataItem } from "../src/dataitem";
import { LocalEd25519Signer } from "../src/signer";
import { toEvidenceBundle } from "../src/evidence";
import type { EvidenceBundle } from "../src/evidence";
import type { InclusionReceipt } from "../src/batch";
import type { UploadReceipt, Uploader } from "../src/turbo";

class StubUploader implements Uploader {
  readonly items: Uint8Array[] = [];
  async upload(dataItem: Uint8Array): Promise<UploadReceipt> {
    this.items.push(dataItem);
    return { txId: await txIdFromDataItem(dataItem), raw: {} };
  }
}

const SEED_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

async function anchorBatch(n: number): Promise<{ signer: LocalEd25519Signer; receipts: InclusionReceipt[] }> {
  const signer = LocalEd25519Signer.fromSeedHex(SEED_HEX);
  const anchorer = createAnchorer({ uploader: new StubUploader(), warn: () => {}, signer });
  const batch = anchorer.batch({ maxEvents: n });
  const handles = Array.from({ length: n }, (_, i) => batch.add({ data: `event-${i}`, metadata: { i } }));
  const receipts = await Promise.all(handles.map((h) => h.receipt()));
  return { signer, receipts };
}

// Full bundle verification using ONLY the shipping @ar.io/proof kernel — a
// faithful re-implementation of the verify algorithm (evidence-bundle §4).
async function verifyBundleWithKernel(bundle: EvidenceBundle): Promise<{
  specOk: boolean;
  bodyHashOk: boolean;
  signatureOk: boolean;
  checkpointsOk: boolean;
  eventsOk: boolean;
  eventBindings: (boolean | null)[];
}> {
  const specOk = bundle.spec_version === "ario.evidence/v1";

  // Wrapper signature: strip signature, JCS, Ed25519 against public_key.
  const { signature, ...preSig } = bundle;
  const signatureOk = await ed25519Verify(signature, utf8(jcs(preSig)), bundle.public_key);

  // body_hash = SHA-256(JCS(body)).
  const bodyHashOk = (await sha256Hex(utf8(jcs(bundle.body)))) === bundle.body_hash;

  // Per-checkpoint: envelope binds to its record, and the committed merkle_root
  // matches the bundle's claimed root.
  const byTx = new Map(bundle.body.checkpoints.map((c) => [c.tx_id, c]));
  let checkpointsOk = bundle.body.checkpoints.length > 0;
  for (const cp of bundle.body.checkpoints) {
    const res = await verifyEnvelope(cp.envelope, { payloadBytes: hexBytes(cp.record_bytes) });
    const record = JSON.parse(new TextDecoder().decode(hexBytes(cp.record_bytes))) as {
      event?: { merkle_root?: string };
    };
    if (!(res.ok && res.payloadHashOk === true && record.event?.merkle_root === cp.merkle_root)) {
      checkpointsOk = false;
    }
  }

  // Per-event: signature + payload binding + inclusion against its checkpoint.
  let eventsOk = true;
  const eventBindings: (boolean | null)[] = [];
  for (const ev of bundle.body.events) {
    const res = await verifyEnvelope(
      ev.envelope,
      ev.record_bytes !== undefined ? { payloadBytes: hexBytes(ev.record_bytes) } : {},
    );
    eventBindings.push(res.payloadHashOk);
    const cp = byTx.get(ev.inclusion.checkpoint_tx_id);
    const inclOk = cp
      ? await verifyInclusion(
          hexBytes(ev.inclusion.leaf_hash),
          ev.inclusion.leaf_index,
          ev.inclusion.leaf_count,
          ev.inclusion.audit_path.map(hexBytes),
          hexBytes(cp.merkle_root),
        )
      : false;
    if (!(res.ok && inclOk && cp !== undefined)) eventsOk = false;
  }

  return { specOk, bodyHashOk, signatureOk, checkpointsOk, eventsOk, eventBindings };
}

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

describe("toEvidenceBundle — round trip with the shipping kernel", () => {
  it("a 3-event batch produces a fully-green ario.anchor.trace/v1 bundle", async () => {
    const { signer, receipts } = await anchorBatch(3);
    const bundle = await toEvidenceBundle(receipts, { signer });

    expect(bundle.spec_version).toBe("ario.evidence/v1");
    expect(bundle.body_type).toBe("ario.anchor.trace/v1");
    expect(bundle.signature_alg).toBe("ed25519");
    // The wrapper key is the SAME producer key the envelopes were signed with.
    expect(bundle.public_key).toBe(bytesToHex(await signer.publicKey()));
    // One shared checkpoint, three events.
    expect(bundle.body.checkpoints).toHaveLength(1);
    expect(bundle.body.events).toHaveLength(3);

    const v = await verifyBundleWithKernel(bundle);
    expect(v.specOk).toBe(true);
    expect(v.signatureOk).toBe(true);
    expect(v.bodyHashOk).toBe(true);
    expect(v.checkpointsOk).toBe(true);
    expect(v.eventsOk).toBe(true);
    expect(v.eventBindings).toEqual([true, true, true]);
  });

  it("de-duplicates the shared checkpoint across all events in one window", async () => {
    const { signer, receipts } = await anchorBatch(5);
    const bundle = await toEvidenceBundle(receipts, { signer });
    // All five events anchored in one window → exactly one checkpoint entry.
    expect(bundle.body.checkpoints).toHaveLength(1);
    expect(new Set(bundle.body.events.map((e) => e.inclusion.checkpoint_tx_id)).size).toBe(1);
    expect(bundle.body.events[0]!.inclusion.checkpoint_tx_id).toBe(bundle.body.checkpoints[0]!.tx_id);
  });

  it("Uint8Array fields serialize as lowercase hex (family convention)", async () => {
    const { signer, receipts } = await anchorBatch(2);
    const bundle = await toEvidenceBundle(receipts, { signer });
    for (const ev of bundle.body.events) {
      expect(ev.record_bytes).toMatch(/^[0-9a-f]+$/);
      expect(ev.inclusion.leaf_hash).toMatch(/^[0-9a-f]{64}$/);
    }
    for (const cp of bundle.body.checkpoints) {
      expect(cp.record_bytes).toMatch(/^[0-9a-f]+$/);
      expect(cp.merkle_root).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe("ario.bundle() — zero-ceremony convenience on the anchorer", () => {
  it("signs the wrapper with the anchorer's OWN signer and verifies green (zero-arg)", async () => {
    // Dev mode auto-generates the signer — the call site never sees it.
    const ario = createAnchorer({ uploader: new StubUploader(), warn: () => {} });
    const batch = ario.batch({ maxEvents: 3 });
    const receipts = await Promise.all(
      Array.from({ length: 3 }, (_, i) => batch.add({ data: `event-${i}` }).receipt()),
    );

    // Zero signer handling — no second key to hand-create and pass around.
    const bundle = await ario.bundle(receipts);

    // The wrapper key is the anchorer's OWN key — the SAME key that signed the
    // events. Reading it from the anchorer (not from a held signer) proves it.
    expect(bundle.public_key).toBe(await ario.publicKey());
    expect(bundle.body.events[0]!.envelope.public_key).toBe(await ario.publicKey());
    // The sensible default issuer.
    expect(bundle.issuer).toEqual({ kind: "producer" });
    expect(bundle.body.checkpoints).toHaveLength(1);
    expect(bundle.body.events).toHaveLength(3);

    // Round-trips green through the shipping @ar.io/proof verify path.
    const v = await verifyBundleWithKernel(bundle);
    expect(v.specOk).toBe(true);
    expect(v.signatureOk).toBe(true);
    expect(v.bodyHashOk).toBe(true);
    expect(v.checkpointsOk).toBe(true);
    expect(v.eventsOk).toBe(true);
    expect(v.eventBindings).toEqual([true, true, true]);
  });

  it("carries the configured subject's producer_id into the default issuer", async () => {
    const ario = createAnchorer({
      uploader: new StubUploader(),
      warn: () => {},
      subject: { type: "producer", producer_id: "acme-app" },
    });
    const batch = ario.batch({ maxEvents: 1 });
    const receipts = [await batch.add({ data: "one" }).receipt()];

    const bundle = await ario.bundle(receipts);
    expect(bundle.issuer).toEqual({ kind: "producer", producer_id: "acme-app" });
  });

  it("lets the caller override issuer and gateway", async () => {
    const ario = createAnchorer({ uploader: new StubUploader(), warn: () => {} });
    const batch = ario.batch({ maxEvents: 1 });
    const receipts = [await batch.add({ data: "one" }).receipt()];

    const bundle = await ario.bundle(receipts, {
      issuer: { kind: "producer", producer_id: "override" },
      gateway: "https://example.gateway",
    });
    expect(bundle.issuer).toEqual({ kind: "producer", producer_id: "override" });
    expect(bundle.gateway).toBe("https://example.gateway");
    // Still verifies green — override touches only the wrapper, not the body.
    const v = await verifyBundleWithKernel(bundle);
    expect(v.signatureOk).toBe(true);
    expect(v.eventsOk).toBe(true);
  });
});

describe("toEvidenceBundle — tamper is caught downstream", () => {
  it("flipping one byte of a record_bytes makes THAT event fail to bind", async () => {
    const { signer, receipts } = await anchorBatch(3);
    const bundle = await toEvidenceBundle(receipts, { signer });

    // An auditor receives a bundle with one event's committed record mutated.
    const rb = bundle.body.events[1]!.record_bytes!;
    bundle.body.events[1]!.record_bytes = rb.slice(0, -1) + (rb.endsWith("0") ? "1" : "0");

    const v = await verifyBundleWithKernel(bundle);
    // The mutated record no longer binds to its envelope's payload_hash.
    expect(v.eventBindings[1]).toBe(false);
    expect(v.eventsOk).toBe(false);
    // The body_hash + wrapper signature ALSO break (we changed the signed body).
    expect(v.bodyHashOk).toBe(false);
    expect(v.signatureOk).toBe(false);
  });

  it("flipping an audit_path entry breaks that event's inclusion proof", async () => {
    const { signer, receipts } = await anchorBatch(4);
    const bundle = await toEvidenceBundle(receipts, { signer });
    const ap = bundle.body.events[2]!.inclusion.audit_path;
    ap[0] = ap[0]!.slice(0, -1) + (ap[0]!.endsWith("0") ? "1" : "0");

    const v = await verifyBundleWithKernel(bundle);
    expect(v.eventsOk).toBe(false);
  });
});

describe("toEvidenceBundle — withheld record is undetermined, not a failure", () => {
  it("dropping a record_bytes yields payload-undetermined (null), envelope still verifies", async () => {
    const { signer, receipts } = await anchorBatch(3);
    const bundle = await toEvidenceBundle(receipts, { signer });

    // A producer withholds one event's record (external commitment, not disclosed).
    delete bundle.body.events[1]!.record_bytes;
    // Re-sign the wrapper so we isolate the withheld-record semantics from a
    // wrapper-tamper failure (the producer would emit it withheld from the start).
    await reSign(bundle, signer);

    const v = await verifyBundleWithKernel(bundle);
    expect(v.signatureOk).toBe(true);
    expect(v.bodyHashOk).toBe(true);
    // The withheld event: signature-valid, binding undetermined (null) — NOT failed.
    expect(v.eventBindings[1]).toBe(null);
    // The disclosed events still bind.
    expect(v.eventBindings[0]).toBe(true);
    expect(v.eventBindings[2]).toBe(true);
  });
});

describe("toEvidenceBundle — input validation", () => {
  it("rejects an empty receipt list", async () => {
    const signer = LocalEd25519Signer.fromSeedHex(SEED_HEX);
    await expect(toEvidenceBundle([], { signer })).rejects.toThrow(/at least one/);
  });

  it("requires a signer", async () => {
    const { receipts } = await anchorBatch(1);
    await expect(toEvidenceBundle(receipts, {} as never)).rejects.toThrow(/signer/);
  });
});

// Mirror the producer's wrapper signing so a test can isolate body edits.
async function reSign(bundle: EvidenceBundle, signer: LocalEd25519Signer): Promise<void> {
  bundle.body_hash = await sha256Hex(utf8(jcs(bundle.body)));
  const { signature: _s, ...pre } = bundle;
  bundle.public_key = bytesToHex(await signer.publicKey());
  bundle.signature = bytesToHex(await signer.sign(utf8(jcs(pre))));
}
