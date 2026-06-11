import { bytesToHex, ed25519Verify, sha256Bytes, utf8 } from "@ar.io/proof";
import { describe, expect, it } from "vitest";

import {
  SIGNATURE_TYPE_SOLANA,
  SolanaWalletSigner,
  buildSignedDataItem,
  dataItemDeepHash,
  txIdFromDataItem,
} from "../src/dataitem";
import { LocalEd25519Signer } from "../src/signer";

const SEED_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const PUB_HEX = "207a067892821e25d770f1fba0c47c11ff4b813e54162ece9eb839e076231ab6";

const TAGS = [
  { name: "Content-Type", value: "application/json" },
  { name: "App-Name", value: "ario-anchor" },
];
const DATA = utf8('{"hello":"world"}');

function signer() {
  return new SolanaWalletSigner(LocalEd25519Signer.fromSeedHex(SEED_HEX));
}

describe("buildSignedDataItem (sigType 2, Solana ed25519)", () => {
  it("lays out the wire format exactly", async () => {
    const item = await buildSignedDataItem(signer(), DATA, TAGS);
    const view = new DataView(item.buffer);

    expect(view.getUint16(0, true)).toBe(SIGNATURE_TYPE_SOLANA); // LE wire form
    const owner = item.subarray(2 + 64, 2 + 64 + 32);
    expect(bytesToHex(owner)).toBe(PUB_HEX);
    expect(item[2 + 64 + 32]).toBe(0); // target absent
    expect(item[2 + 64 + 32 + 1]).toBe(0); // anchor absent

    const tagCountPos = 2 + 64 + 32 + 2;
    expect(view.getBigUint64(tagCountPos, true)).toBe(2n);
    const avroLen = Number(view.getBigUint64(tagCountPos + 8, true));
    const avroEnd = tagCountPos + 16 + avroLen;
    expect(item.subarray(avroEnd)).toEqual(DATA);
    expect(item.length).toBe(avroEnd + DATA.length);
  });

  it("signs the deep hash with the DECIMAL-STRING sigType (raw, no extra SHA-256)", async () => {
    const item = await buildSignedDataItem(signer(), DATA, TAGS);
    const sig = item.subarray(2, 2 + 64);
    const owner = item.subarray(2 + 64, 2 + 64 + 32);

    const tagCountPos = 2 + 64 + 32 + 2;
    const view = new DataView(item.buffer);
    const avroLen = Number(view.getBigUint64(tagCountPos + 8, true));
    const avro = item.subarray(tagCountPos + 16, tagCountPos + 16 + avroLen);

    const dh = await dataItemDeepHash(2, owner, avro, DATA);
    expect(dh.length).toBe(48);
    expect(await ed25519Verify(bytesToHex(sig), dh, bytesToHex(owner))).toBe(true);
  });

  it("is deterministic (ed25519 is RFC 8032 deterministic)", async () => {
    const a = await buildSignedDataItem(signer(), DATA, TAGS);
    const b = await buildSignedDataItem(signer(), DATA, TAGS);
    expect(bytesToHex(a)).toBe(bytesToHex(b));
  });

  it("rejects empty data and wrong-size owner", async () => {
    await expect(buildSignedDataItem(signer(), new Uint8Array(0), TAGS)).rejects.toThrow(
      /empty data/,
    );
    const bad = new SolanaWalletSigner({
      publicKey: async () => new Uint8Array(31),
      sign: async () => new Uint8Array(64),
    });
    await expect(buildSignedDataItem(bad, DATA, TAGS)).rejects.toThrow(/owner/);
  });
});

describe("txIdFromDataItem", () => {
  it("predicts base64url(sha256(signature)), unpadded, 43 chars", async () => {
    const item = await buildSignedDataItem(signer(), DATA, TAGS);
    const txId = await txIdFromDataItem(item);
    expect(txId).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const sig = item.subarray(2, 2 + 64);
    const expected = Buffer.from(await sha256Bytes(sig)).toString("base64url");
    expect(txId).toBe(expected);
  });

  it("rejects unknown signature types", async () => {
    const bogus = new Uint8Array(100);
    bogus[0] = 99;
    await expect(txIdFromDataItem(bogus)).rejects.toThrow(/unsupported/);
  });
});
