// Verify round-trip (PRD testing seam 5 + 8, network-free): real signing and
// real verification, stub upload. Proves the adapter's anchored output
// verifies GREEN through the @ar.io/proof@0.2.0 full-family verifier — the
// claim that was primitive-level only until ario.events/v1 entered the
// kernel accept-set. Uses a real createAnchorer with a stub Uploader (txId
// derived from the actual data-item bytes), so envelopes/signatures/Merkle
// are genuine; only the Turbo POST is stubbed.

import { createAnchorer, txIdFromDataItem } from "@ar.io/anchor";
import { hexToBytes, verifyEnvelope, verifyInclusion } from "@ar.io/proof";
import { describe, expect, it } from "vitest";

import { anchorCallbacks } from "../src/index";

// Honest stub: the txId is what the bytes derive (mirrors the anchor
// package's own seam-4 stub). No network.
function stubUploader() {
  return {
    async upload(dataItem: Uint8Array) {
      return { txId: await txIdFromDataItem(dataItem), raw: {} };
    },
  };
}

async function anchorAChain() {
  const anchorer = createAnchorer({ uploader: stubUploader(), warn: () => {} });
  const provenance = anchorCallbacks(anchorer);
  provenance.handleChainStart({}, { question: "what is provenance?" }, "root");
  provenance.handleChatModelStart({}, [[]], "child", "root");
  provenance.handleLLMEnd({ generations: [] }, "child", "root");
  provenance.handleChainEnd({ answer: "a verifiable history" }, "root");
  return provenance.close();
}

describe("verifyEnvelope-green round-trip (@ar.io/proof 0.2.0 full-family)", () => {
  it("every anchored event verifies green when its retained record is supplied", async () => {
    const receipts = await anchorAChain();
    expect(receipts.length).toBe(4);

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
    // External commitment: without the committed record the verifier can
    // confirm the signature but cannot check the payload binding. The
    // widened contract reports payloadHashOk === null ("semantics-
    // undetermined") — NOT false. Callers asserting a full proof must treat
    // null as "supply the record", never as a pass and never as a tamper.
    const [receipt] = await anchorAChain();
    const result = await verifyEnvelope(receipt!.envelope);
    expect(result.signatureOk).toBe(true);
    expect(result.payloadHashOk).toBeNull();
    expect(result.payloadHashOk).not.toBe(false); // null is not failure
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
