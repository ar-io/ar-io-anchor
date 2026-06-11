// Adapter tests at the anchorer boundary (PRD testing seam 6): a spy
// anchorer and a fake S3 client — zero cryptography, zero network. The
// adapter's three jobs are asserted directly: store the object, translate
// the event into a correctly shaped anchor call, persist the provenance
// record beside the object.

import type { Anchorer, AnchorInput, AnchorReceipt } from "@ar.io/anchor";
import { describe, expect, it } from "vitest";

import { anchoredS3 } from "../src/index";

const CANNED_RECORD = {
  payload_version: 1,
  spec_version: "ario.events/v1",
  event_type: "s3.object_stored",
  subject: { type: "producer" },
  previous_hash: "GENESIS",
  event: { content_hash: "c".repeat(64) },
  context: {},
  metadata: {},
  extras: {},
};

function spyAnchorer() {
  const calls: AnchorInput[] = [];
  const receipt: AnchorReceipt = {
    txId: "TX_SPY",
    eventId: "1f0e9a4c-3b2d-4d5e-8f6a-7b8c9d0e1f2a",
    contentHash: "c".repeat(64),
    payloadHash: "d".repeat(64),
    envelope: {
      spec_version: "ario.events/v1",
      event_id: "1f0e9a4c-3b2d-4d5e-8f6a-7b8c9d0e1f2a",
      payload_hash: "d".repeat(64),
      signed_at: "2026-06-11T00:00:00Z",
      environment: "dev",
      public_key: "e".repeat(64),
      signature: "f".repeat(128),
    },
    envelopeBytes: new Uint8Array(0),
    recordBytes: new TextEncoder().encode(JSON.stringify(CANNED_RECORD)),
    environment: "dev",
    explorerUrl: "https://viewblock.io/arweave/tx/TX_SPY",
  };
  const anchorer = {
    environment: "dev",
    anchor: async (input: AnchorInput) => {
      calls.push(input);
      return receipt;
    },
    batch: () => {
      throw new Error("unused");
    },
    publicKey: async () => "e".repeat(64),
    close: async () => {},
  } as unknown as Anchorer;
  return { anchorer, calls, receipt };
}

function fakeS3() {
  const sends: { Bucket?: string; Key?: string; Body?: unknown; ContentType?: string }[] = [];
  return {
    sends,
    client: {
      send: async (cmd: { input: (typeof sends)[number] }) => {
        sends.push(cmd.input);
        return {};
      },
    } as never,
  };
}

describe("anchoredS3.putObject", () => {
  it("stores the object, anchors provenance, and writes the sidecar record", async () => {
    const { anchorer, calls, receipt } = spyAnchorer();
    const { client, sends } = fakeS3();

    const result = await anchoredS3(client, anchorer).putObject({
      Bucket: "models",
      Key: "prod/scorer.pkl",
      Body: "model bytes",
    });

    // Object stored as asked.
    expect(sends[0]).toMatchObject({ Bucket: "models", Key: "prod/scorer.pkl" });

    // Anchor call correctly shaped: adapter-namespaced type + ref locator.
    expect(calls).toEqual([
      { type: "s3.object_stored", data: "model bytes", ref: "s3://models/prod/scorer.pkl" },
    ]);

    // Sidecar beside the object, carrying everything offline verification needs.
    expect(result.provenanceKey).toBe("prod/scorer.pkl.provenance.json");
    expect(sends[1]).toMatchObject({
      Bucket: "models",
      Key: "prod/scorer.pkl.provenance.json",
      ContentType: "application/json",
    });
    const sidecar = JSON.parse(sends[1]!.Body as string);
    expect(sidecar.txId).toBe("TX_SPY");
    expect(sidecar.envelope).toEqual(receipt.envelope);
    expect(sidecar.record).toEqual(CANNED_RECORD);
    expect(sidecar.contentHash).toBe(receipt.contentHash);
    expect(result.receipt).toBe(receipt);
  });

  it("requires Bucket and Key", async () => {
    const { anchorer } = spyAnchorer();
    const { client } = fakeS3();
    await expect(
      anchoredS3(client, anchorer).putObject({ Key: "k", Body: "x" } as never),
    ).rejects.toThrow(/Bucket and Key/);
  });

  it("does not write a sidecar when anchoring fails", async () => {
    const { client, sends } = fakeS3();
    const failing = {
      anchor: async () => {
        throw new Error("funding exhausted");
      },
    } as unknown as Anchorer;
    await expect(
      anchoredS3(client, failing).putObject({ Bucket: "b", Key: "k", Body: "x" }),
    ).rejects.toThrow(/funding exhausted/);
    expect(sends.length).toBe(1); // the object went up; no sidecar
  });
});
