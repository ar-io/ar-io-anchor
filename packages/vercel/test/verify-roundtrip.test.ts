// Verify round-trip (PRD testing seam 5 + 8, network-free): real signing and
// real verification, stub upload. Proves the Vercel adapter's anchored output
// verifies GREEN through the @ar.io/proof@0.2.0 full-family verifier — the
// claim that was primitive-level only until ario.events/v1 entered the kernel
// accept-set. Uses a real createAnchorer with a stub Uploader (txId derived
// from the actual data-item bytes), driven through the real middleware seam;
// only the Turbo POST is stubbed.

import { createAnchorer, txIdFromDataItem } from "@ar.io/anchor";
import { hexToBytes, verifyEnvelope, verifyInclusion } from "@ar.io/proof";
import { describe, expect, it } from "vitest";

import { anchorMiddleware } from "../src/index";

function stubUploader() {
  return {
    async upload(dataItem: Uint8Array) {
      return { txId: await txIdFromDataItem(dataItem), raw: {} };
    },
  };
}

// Drive the middleware's generate seam directly with a stub doGenerate — no
// network, real envelopes. Returns the inclusion receipts.
async function anchorAChain() {
  const anchorer = createAnchorer({ uploader: stubUploader(), warn: () => {} });
  const mw = anchorMiddleware(anchorer);
  const gen = () =>
    mw.wrapGenerate({
      doGenerate: async () => ({ content: [], usage: {}, finishReason: "stop" }) as never,
      params: { prompt: "what is provenance?", providerOptions: { ario: { chainKey: "req-1" } } },
    } as never);
  await gen(); // generate_start + generate_end
  return mw.close();
}

describe("verifyEnvelope-green round-trip (@ar.io/proof 0.2.0 full-family)", () => {
  it("every anchored event verifies green when its retained record is supplied", async () => {
    const receipts = await anchorAChain();
    expect(receipts.length).toBe(2); // generate_start + generate_end

    for (const r of receipts) {
      const result = await verifyEnvelope(r.envelope, { payloadBytes: r.recordBytes });
      expect(result.ok).toBe(true);
      expect(result.specVersionOk).toBe(true); // ario.events/v1 now accepted
      expect(result.signatureOk).toBe(true);
      expect(result.payloadHashOk).toBe(true); // full external-commitment bind
      expect(result.errors).toEqual([]);
    }
  });

  it("each event's leaf is included in its checkpoint root (RFC 9162)", async () => {
    const receipts = await anchorAChain();
    for (const r of receipts) {
      const included = await verifyInclusion(
        hexToBytes(r.leafHash),
        r.leafIndex,
        r.leafCount,
        r.auditPath.map(hexToBytes),
        hexToBytes(r.root),
      );
      expect(included).toBe(true);
    }
  });

  it("signature-only verification (record withheld) is undetermined, not failed", async () => {
    // External commitment: without the committed record the verifier confirms
    // the signature but cannot check binding — payloadHashOk === null
    // ("semantics-undetermined"), NOT false. Callers asserting a full proof
    // must treat null as "supply the record", never as a pass or a tamper.
    const [receipt] = await anchorAChain();
    const result = await verifyEnvelope(receipt!.envelope);
    expect(result.signatureOk).toBe(true);
    expect(result.payloadHashOk).toBeNull();
    expect(result.payloadHashOk).not.toBe(false);
  });

  it("a tampered record is caught as a binding failure (payloadHashOk false)", async () => {
    const [receipt] = await anchorAChain();
    const tampered = new TextEncoder().encode("not the committed record");
    const result = await verifyEnvelope(receipt!.envelope, { payloadBytes: tampered });
    expect(result.signatureOk).toBe(true); // signature still valid over the envelope
    expect(result.payloadHashOk).toBe(false); // but the bytes don't bind
    expect(result.ok).toBe(false);
  });
});
