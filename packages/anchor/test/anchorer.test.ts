import { jcs, sha256Hex, utf8 } from "@ar.io/proof";
import { describe, expect, it } from "vitest";

import { createAnchorer } from "../src/anchorer";
import { txIdFromDataItem } from "../src/dataitem";
import { ProductionConfigError, TxIdMismatchError } from "../src/errors";
import { LocalEd25519Signer } from "../src/signer";
import { SolanaWalletSigner } from "../src/dataitem";
import { MemoryStore } from "../src/store";
import type { UploadReceipt, Uploader } from "../src/turbo";

// Honest stub (seam 4): deterministic, returns the txId the bytes derive.
class StubUploader implements Uploader {
  readonly items: Uint8Array[] = [];
  async upload(dataItem: Uint8Array): Promise<UploadReceipt> {
    this.items.push(dataItem);
    return { txId: await txIdFromDataItem(dataItem), raw: {} };
  }
}

const noWarn = () => {};

function devAnchorer(extra: Parameters<typeof createAnchorer>[0] = {}) {
  const uploader = new StubUploader();
  const anchorer = createAnchorer({ uploader, warn: noWarn, ...extra });
  return { anchorer, uploader };
}

describe("createAnchorer — the structural gate", () => {
  it("dev mode is zero-config and warns loudly", () => {
    const warnings: string[] = [];
    const { anchorer } = devAnchorer({ warn: (m) => warnings.push(m) });
    expect(anchorer.environment).toBe("dev");
    expect(warnings.join(" ")).toMatch(/DEV MODE/);
  });

  it("production THROWS without explicit signer + wallet + subject", () => {
    expect(() => createAnchorer({ environment: "production" })).toThrow(
      ProductionConfigError,
    );
    try {
      createAnchorer({ environment: "production", signer: LocalEd25519Signer.generate() });
    } catch (e) {
      expect((e as Error).message).toContain("wallet");
      expect((e as Error).message).toContain("subject");
      expect((e as Error).message).not.toContain("signer,");
    }
  });

  it("production works with explicit credentials and stamps the envelope", async () => {
    const uploader = new StubUploader();
    const anchorer = createAnchorer({
      environment: "production",
      signer: LocalEd25519Signer.generate(),
      wallet: new SolanaWalletSigner(LocalEd25519Signer.generate()),
      subject: { type: "producer", producer_id: "acme-prod" },
      uploader,
      warn: noWarn,
    });
    const receipt = await anchorer.anchor({ data: "payload" });
    expect(receipt.environment).toBe("production");
    expect(receipt.envelope.environment).toBe("production");
  });
});

describe("anchor() single-shot", () => {
  it("anchors bytes and returns a complete receipt", async () => {
    const { anchorer, uploader } = devAnchorer();
    const receipt = await anchorer.anchor({ data: utf8("hello world"), ref: "s3://b/k" });

    expect(receipt.txId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(receipt.gatewayUrl).toBe(`https://turbo-gateway.com/${receipt.txId}`);
    expect(receipt.contentHash).toBe(await sha256Hex(utf8("hello world")));
    expect(receipt.envelope.environment).toBe("dev");
    expect(receipt.envelope.payload_hash).toBe(receipt.payloadHash);
    expect(uploader.items.length).toBe(1);

    // External commitment: recordBytes are the retention obligation and
    // re-derive payload_hash.
    expect(await sha256Hex(receipt.recordBytes)).toBe(receipt.payloadHash);
    const record = JSON.parse(new TextDecoder().decode(receipt.recordBytes));
    expect(record.event.content_hash).toBe(receipt.contentHash);
    expect(record.event.content_length).toBe(11);
    expect(record.event.ref).toBe("s3://b/k");
    expect(jcs(record)).toBe(new TextDecoder().decode(receipt.recordBytes));
  });

  it("hashes string, bytes, and async-iterable inputs identically", async () => {
    const { anchorer } = devAnchorer();
    async function* stream() {
      yield utf8("hello ");
      yield utf8("world");
    }
    const a = await anchorer.anchor({ data: "hello world" });
    const b = await anchorer.anchor({ data: utf8("hello world") });
    const c = await anchorer.anchor({ data: stream() });
    expect(b.contentHash).toBe(a.contentHash);
    expect(c.contentHash).toBe(a.contentHash);
    const record = JSON.parse(new TextDecoder().decode(c.recordBytes));
    expect(record.event.content_length).toBe(11);
  });

  it("accepts a pre-computed contentHash (validated), refuses both/neither", async () => {
    const { anchorer } = devAnchorer();
    const hash = "b".repeat(64);
    const receipt = await anchorer.anchor({ contentHash: hash });
    expect(receipt.contentHash).toBe(hash);

    await expect(anchorer.anchor({})).rejects.toThrow(/exactly one/);
    await expect(anchorer.anchor({ data: "x", contentHash: hash })).rejects.toThrow(
      /exactly one/,
    );
    await expect(anchorer.anchor({ contentHash: "nope" })).rejects.toThrow(/sha256/);
  });

  it("chains per key: GENESIS first, then previous record hash; unchained stays GENESIS", async () => {
    const { anchorer } = devAnchorer();
    const r1 = await anchorer.anchor({ data: "one", chain: "orders" });
    const r2 = await anchorer.anchor({ data: "two", chain: "orders" });
    const r3 = await anchorer.anchor({ data: "three" });

    const rec1 = JSON.parse(new TextDecoder().decode(r1.recordBytes));
    const rec2 = JSON.parse(new TextDecoder().decode(r2.recordBytes));
    const rec3 = JSON.parse(new TextDecoder().decode(r3.recordBytes));
    expect(rec1.previous_hash).toBe("GENESIS");
    expect(rec1.context.chain_key).toBe("orders");
    expect(rec2.previous_hash).toBe(r1.payloadHash);
    expect(rec3.previous_hash).toBe("GENESIS");
    expect(rec3.context.chain_key).toBeUndefined();
  });

  it("does not advance the chain head when the upload fails", async () => {
    const store = new MemoryStore();
    const failing: Uploader = {
      upload: async () => {
        throw new Error("upstream down");
      },
    };
    const anchorer = createAnchorer({ uploader: failing, store, warn: noWarn });
    await expect(anchorer.anchor({ data: "x", chain: "c" })).rejects.toThrow(
      /upstream down/,
    );
    expect(await store.getHead("c")).toBeNull();

    // Recovery: a working uploader picks up from GENESIS.
    const { anchorer: ok } = devAnchorer({ store });
    const r = await ok.anchor({ data: "x", chain: "c" });
    const rec = JSON.parse(new TextDecoder().decode(r.recordBytes));
    expect(rec.previous_hash).toBe("GENESIS");
    expect(await store.getHead("c")).toBe(r.payloadHash);
  });

  it("detects predicted-vs-returned TX ID divergence", async () => {
    const lying: Uploader = { upload: async () => ({ txId: "WRONG", raw: {} }) };
    const anchorer = createAnchorer({ uploader: lying, warn: noWarn });
    await expect(anchorer.anchor({ data: "x" })).rejects.toBeInstanceOf(TxIdMismatchError);
  });

  it("passes eventId through for idempotency", async () => {
    const { anchorer } = devAnchorer();
    const id = "9f8e7d6c-5b4a-4d3c-8b1a-0f9e8d7c6b5a";
    const receipt = await anchorer.anchor({ data: "x", eventId: id });
    expect(receipt.eventId).toBe(id);
    expect(receipt.envelope.event_id).toBe(id);
  });

  it("publishes the Content-Hash tag only on explicit opt-in", async () => {
    const plain = devAnchorer();
    await plain.anchorer.anchor({ data: "secret" });
    const disclosing = devAnchorer({ publishContentHashTag: true });
    const r = await disclosing.anchorer.anchor({ data: "secret" });

    const plainItem = Buffer.from(plain.uploader.items[0]!).toString("latin1");
    const disclosingItem = Buffer.from(disclosing.uploader.items[0]!).toString("latin1");
    expect(plainItem).not.toContain("Content-Hash");
    expect(disclosingItem).toContain("Content-Hash");
    expect(disclosingItem).toContain(r.contentHash);
  });

  it("exposes the identity public key and a callable close()", async () => {
    const { anchorer } = devAnchorer();
    expect(await anchorer.publicKey()).toMatch(/^[0-9a-f]{64}$/);
    await anchorer.close();
  });
});
