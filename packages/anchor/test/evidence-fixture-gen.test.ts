// Guards scripts/gen-evidence-fixture.mjs against rot: the generator must keep
// producing an ario.evidence/v1 / ario.anchor.trace/v1 bundle that verifies
// green under the SHIPPING @ar.io/proof kernel. The committed golden fixture
// (ar-io-proof/ts/test/fixtures/anchor-trace-bundle.golden.json) is regenerated
// from this exact path; this test pins that the path stays sound so a future
// format change can't silently produce an unverifiable golden file.
//
// Mirrors the generator's recipe (fixed seed, fixed payloads, fake clock, stub
// uploader) rather than shelling out to the .mjs, so it runs against src/ in CI
// without a pre-build step. The .mjs is the committed reproducibility record.

import { ed25519Verify, jcs, sha256Hex, utf8, verifyEnvelope, verifyInclusion } from "@ar.io/proof";
import { describe, expect, it } from "vitest";

import { createAnchorer } from "../src/anchorer";
import { txIdFromDataItem } from "../src/dataitem";
import { LocalEd25519Signer } from "../src/signer";
import { toEvidenceBundle } from "../src/evidence";
import type { EvidenceBundle } from "../src/evidence";
import type { Uploader, UploadReceipt } from "../src/turbo";

const SEED_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const WINDOW_BASE_MS = Date.UTC(2026, 5, 22, 0, 0, 0);

class StubUploader implements Uploader {
  async upload(dataItem: Uint8Array): Promise<UploadReceipt> {
    return { txId: await txIdFromDataItem(dataItem), raw: {} };
  }
}

function fakeTimers() {
  let t = WINDOW_BASE_MS;
  return {
    now: () => t,
    setTimeout: () => {
      t += 1000;
      return 0 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: () => {},
  };
}

// The exact recipe gen-evidence-fixture.mjs runs.
async function buildFixtureBundle(): Promise<EvidenceBundle> {
  const signer = LocalEd25519Signer.fromSeedHex(SEED_HEX);
  const anchorer = createAnchorer({
    signer,
    subject: { type: "producer", producer_id: "fixture-producer" },
    environment: "dev",
    uploader: new StubUploader(),
    warn: () => {},
    timers: fakeTimers(),
  });
  const batch = anchorer.batch({ maxEvents: 3, name: "fixture" });
  const handles = [
    batch.add({ type: "llm.call", data: "fixture-event-0", metadata: { i: 0 } }),
    batch.add({ type: "llm.call", data: "fixture-event-1", metadata: { i: 1 } }),
    batch.add({ type: "llm.call", data: "fixture-event-2", metadata: { i: 2 } }),
  ];
  const receipts = await Promise.all(handles.map((h) => h.receipt()));
  return toEvidenceBundle(receipts, {
    signer,
    issuer: { kind: "producer", producer_id: "fixture-producer" },
    generatedAt: "2026-06-22T00:00:00.000Z",
    previousHash: "GENESIS",
    // Mirror gen-evidence-fixture.mjs: event 0 discloses its raw bytes in-body.
    disclose: { [receipts[0]!.eventId]: "fixture-event-0" },
  });
}

describe("gen-evidence-fixture recipe stays kernel-verifiable", () => {
  it("produces an ario.anchor.trace/v1 bundle the kernel verifies fully green", async () => {
    const bundle = await buildFixtureBundle();

    expect(bundle.spec_version).toBe("ario.evidence/v1");
    expect(bundle.body_type).toBe("ario.anchor.trace/v1");
    expect(bundle.body.events).toHaveLength(3);
    expect(bundle.body.checkpoints).toHaveLength(1);

    // Wrapper: strip signature, JCS, Ed25519 against public_key; body_hash recompute.
    const { signature, ...preSig } = bundle;
    expect(await ed25519Verify(signature, utf8(jcs(preSig)), bundle.public_key)).toBe(true);
    expect(await sha256Hex(utf8(jcs(bundle.body)))).toBe(bundle.body_hash);

    // Every checkpoint binds + every event binds + every inclusion proof holds.
    const byTx = new Map(bundle.body.checkpoints.map((c) => [c.tx_id, c]));
    for (const cp of bundle.body.checkpoints) {
      const res = await verifyEnvelope(cp.envelope, { payloadBytes: hexBytes(cp.record_bytes) });
      expect(res.ok && res.payloadHashOk === true).toBe(true);
    }
    for (const ev of bundle.body.events) {
      const res = await verifyEnvelope(ev.envelope, {
        payloadBytes: hexBytes(ev.record_bytes!),
      });
      expect(res.ok).toBe(true);
      expect(res.payloadHashOk).toBe(true);
      const cp = byTx.get(ev.inclusion.checkpoint_tx_id)!;
      const inclOk = await verifyInclusion(
        hexBytes(ev.inclusion.leaf_hash),
        ev.inclusion.leaf_index,
        ev.inclusion.leaf_count,
        ev.inclusion.audit_path.map(hexBytes),
        hexBytes(cp.merkle_root),
      );
      expect(inclOk).toBe(true);
    }

    // Disclosure: event 0 carries its raw bytes in-body (hex), events 1 & 2 do
    // not; the disclosed hex hashes to the event's committed content_hash.
    expect(typeof bundle.body.events[0]!.content).toBe("string");
    expect(bundle.body.events[1]!.content).toBeUndefined();
    expect(bundle.body.events[2]!.content).toBeUndefined();
    const rec0 = JSON.parse(new TextDecoder().decode(hexBytes(bundle.body.events[0]!.record_bytes!)));
    expect(await sha256Hex(hexBytes(bundle.body.events[0]!.content!))).toBe(rec0.event.content_hash);
  });
});

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
