// Byte-pin against the ecosystem reference implementation (PRD testing seam
// 3, second half). arbundles is a devDependency ONLY — it never enters the
// runtime tree; it exists to prove our hand-rolled builder produces the
// byte-identical data item for the same key, tags, and data. ed25519 is
// deterministic (RFC 8032), so full-byte equality is well-defined.

import { createData, SolanaSigner } from "@dha-team/arbundles";
import { bytesToHex, utf8 } from "@ar.io/proof";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";

import { buildSignedDataItem, SolanaWalletSigner, txIdFromDataItem } from "../src/dataitem";
import { LocalEd25519Signer } from "../src/signer";

const SEED_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const PUB_HEX = "207a067892821e25d770f1fba0c47c11ff4b813e54162ece9eb839e076231ab6";

const TAGS = [
  { name: "Content-Type", value: "application/json" },
  { name: "App-Name", value: "ario-anchor" },
  { name: "App-Version", value: "ario.events/v1" },
  { name: "Environment", value: "dev" },
];
const DATA = utf8('{"payload_hash":"abc","spec_version":"ario.events/v1"}');

describe("byte-pin vs arbundles", () => {
  it("produces the byte-identical signed data item", async () => {
    const ours = await buildSignedDataItem(
      new SolanaWalletSigner(LocalEd25519Signer.fromSeedHex(SEED_HEX)),
      DATA,
      TAGS,
    );

    // arbundles SolanaSigner wants the base58 64-byte secret (seed || pub).
    const secret = bs58.encode(Buffer.concat([Buffer.from(SEED_HEX, "hex"), Buffer.from(PUB_HEX, "hex")]));
    const theirs = createData(DATA, new SolanaSigner(secret), { tags: TAGS });
    await theirs.sign(new SolanaSigner(secret));

    expect(bytesToHex(ours)).toBe(bytesToHex(new Uint8Array(theirs.getRaw())));
  });

  it("agrees with arbundles on the assigned TX ID", async () => {
    const ours = await buildSignedDataItem(
      new SolanaWalletSigner(LocalEd25519Signer.fromSeedHex(SEED_HEX)),
      DATA,
      TAGS,
    );
    const secret = bs58.encode(Buffer.concat([Buffer.from(SEED_HEX, "hex"), Buffer.from(PUB_HEX, "hex")]));
    const theirs = createData(DATA, new SolanaSigner(secret), { tags: TAGS });
    await theirs.sign(new SolanaSigner(secret));

    expect(await txIdFromDataItem(ours)).toBe(theirs.id);
  });
});
