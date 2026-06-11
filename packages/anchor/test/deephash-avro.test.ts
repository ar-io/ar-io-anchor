// KATs generated independently in Python (hashlib only — same algorithm as
// the Arweave spec and ar-io-agent tools/ans104-conformance), so these pins
// are cross-language, not self-derived.

import { bytesToHex, utf8 } from "@ar.io/proof";
import { describe, expect, it } from "vitest";

import { encodeAvroTags } from "../src/avro";
import { deepHashChunk, deepHashList } from "../src/deephash";

describe("deepHashChunk", () => {
  it("hashes the empty blob", async () => {
    expect(bytesToHex(await deepHashChunk(new Uint8Array(0)))).toBe(
      "fbf00cc444f5fea9dc3bedf62a13fba8ae87e7445fc910567a23bec4eb82fadb1143c433069314d8362983dc3c2e4a38",
    );
  });

  it('hashes "hello world"', async () => {
    expect(bytesToHex(await deepHashChunk(utf8("hello world")))).toBe(
      "42b60b0591c3817049a0658511314e57167cf2992b2c4d2013211707ab65dccf4e1a44fb385107290cf6bdb5e45455df",
    );
  });
});

describe("deepHashList", () => {
  it("hashes the empty list", async () => {
    expect(bytesToHex(await deepHashList([]))).toBe(
      "a69e7d37fdc7f040a9ec16aae84de24fab4a653dac4de0bd247e36bab9fe45d9289c5a04a893c95285812f5cefc9707a",
    );
  });

  it('hashes ["dataitem", "1"]', async () => {
    expect(bytesToHex(await deepHashList([utf8("dataitem"), utf8("1")]))).toBe(
      "9f278255d2108736fbcd24b030a08c84bda932560777bbc25af5bf4b79157c20cd79443ecc7ee5f27c8abe8fb20ca10f",
    );
  });

  it("hashes a full data-item-shaped message (sigType 2, decimal-string form)", async () => {
    // [ "dataitem", "1", "2", owner(32×0xAA), "", "", avro(0x00), data ]
    const dh = await deepHashList([
      utf8("dataitem"),
      utf8("1"),
      utf8("2"), // DECIMAL STRING in the deep hash — never the LE wire form
      new Uint8Array(32).fill(0xaa),
      new Uint8Array(0), // target absent
      new Uint8Array(0), // anchor absent
      new Uint8Array([0x00]), // empty Avro tag set
      utf8("hello world"),
    ]);
    expect(bytesToHex(dh)).toBe(
      "004282ab7b3dc4250889151db3a789cfb6e1bbbc6232b0a2c359cd5d665af42ef46623ce32d9801ee16c6b33bf755a46",
    );
  });
});

describe("encodeAvroTags", () => {
  it("encodes the empty tag set as a single terminator byte", () => {
    expect(bytesToHex(encodeAvroTags([]))).toBe("00");
  });

  it("encodes one tag", () => {
    expect(
      bytesToHex(encodeAvroTags([{ name: "Content-Type", value: "application/json" }])),
    ).toBe("0218436f6e74656e742d54797065206170706c69636174696f6e2f6a736f6e00");
  });

  it("encodes two tags", () => {
    expect(
      bytesToHex(
        encodeAvroTags([
          { name: "A", value: "1" },
          { name: "App-Name", value: "ario-anchor" },
        ]),
      ),
    ).toBe("0402410231104170702d4e616d65166172696f2d616e63686f7200");
  });

  it("rejects more than 127 tags", () => {
    const tags = Array.from({ length: 128 }, (_, i) => ({ name: `t${i}`, value: "v" }));
    expect(() => encodeAvroTags(tags)).toThrow(/127/);
  });
});
