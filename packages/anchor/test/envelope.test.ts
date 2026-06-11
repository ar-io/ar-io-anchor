import { ed25519Verify, jcs, sha256Hex, utf8 } from "@ar.io/proof";
import { describe, expect, it } from "vitest";

import { buildEnvelope } from "../src/envelope";
import { buildEventRecord } from "../src/record";
import { LocalEd25519Signer } from "../src/signer";

// Fixed seed — mirrors the corpus generator's fixture discipline (never a
// real signing key).
const SEED_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const HASH = "c".repeat(64);

const subject = { type: "producer" as const, producer_id: "acme-app" };

function fixedInput() {
  return {
    record: buildEventRecord({ subject, contentHash: HASH, contentLength: 11 }),
    signer: LocalEd25519Signer.fromSeedHex(SEED_HEX),
    environment: "dev" as const,
    eventId: "1f0e9a4c-3b2d-4d5e-8f6a-7b8c9d0e1f2a",
    signedAt: "2026-06-11T00:00:00Z",
  };
}

describe("buildEnvelope", () => {
  it("emits exactly the Minimal-mode skeleton — no disclosure fields, no payload", async () => {
    const { envelope } = await buildEnvelope(fixedInput());
    expect(Object.keys(envelope).sort()).toEqual([
      "environment",
      "event_id",
      "payload_hash",
      "public_key",
      "signature",
      "signed_at",
      "spec_version",
    ]);
    expect(envelope.spec_version).toBe("ario.events/v1");
    expect(envelope.environment).toBe("dev");
  });

  it("commits payload_hash = sha256(JCS(record))", async () => {
    const input = fixedInput();
    const { envelope, payloadHash, recordBytes } = await buildEnvelope(input);
    const expected = await sha256Hex(utf8(jcs(input.record)));
    expect(envelope.payload_hash).toBe(expected);
    expect(payloadHash).toBe(expected);
    expect(new TextDecoder().decode(recordBytes)).toBe(jcs(input.record));
  });

  it("signs JCS(envelope minus signature) verifiably (family invariant 1/3)", async () => {
    const { envelope } = await buildEnvelope(fixedInput());
    const { signature, ...preSignature } = envelope;
    const ok = await ed25519Verify(signature, utf8(jcs(preSignature)), envelope.public_key);
    expect(ok).toBe(true);
  });

  it("returns the canonical bytes of the COMPLETE envelope for upload", async () => {
    const { envelope, envelopeBytes } = await buildEnvelope(fixedInput());
    expect(new TextDecoder().decode(envelopeBytes)).toBe(jcs(envelope));
  });

  it("is deterministic for fixed inputs", async () => {
    const a = await buildEnvelope(fixedInput());
    const b = await buildEnvelope(fixedInput());
    expect(a.envelope).toEqual(b.envelope);
    expect(a.envelopeBytes).toEqual(b.envelopeBytes);
  });

  it("auto-generates a lowercase uuid v4 event_id and RFC 3339 Z signed_at", async () => {
    const { eventId: _e, signedAt: _s, ...rest } = fixedInput();
    const { envelope } = await buildEnvelope(rest);
    expect(envelope.event_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(envelope.signed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  });

  it("carries payload_ref when supplied", async () => {
    const { envelope } = await buildEnvelope({
      ...fixedInput(),
      payloadRef: "s3://bucket/key.provenance.json",
    });
    expect(envelope.payload_ref).toBe("s3://bucket/key.provenance.json");
    // And payload_ref is inside the signed scope.
    const { signature, ...pre } = envelope;
    expect(await ed25519Verify(signature, utf8(jcs(pre)), envelope.public_key)).toBe(true);
  });

  it("requires a valid environment (profile §2: REQUIRED)", async () => {
    const input = fixedInput();
    await expect(
      buildEnvelope({ ...input, environment: undefined as never }),
    ).rejects.toThrow(/environment/i);
    await expect(buildEnvelope({ ...input, environment: "prod" as never })).rejects.toThrow(
      /environment/i,
    );
  });

  it("rejects a non-uuid-v4 eventId", async () => {
    await expect(buildEnvelope({ ...fixedInput(), eventId: "not-a-uuid" })).rejects.toThrow(
      /event_id/i,
    );
  });

  it("rejects a signer returning a wrong-size signature or key", async () => {
    const badSigner = {
      publicKey: async () => new Uint8Array(31),
      sign: async () => new Uint8Array(64),
    };
    await expect(buildEnvelope({ ...fixedInput(), signer: badSigner })).rejects.toThrow(
      /public key/i,
    );
  });
});

describe("LocalEd25519Signer", () => {
  it("derives the fixed corpus keypair from the fixed seed", async () => {
    const signer = LocalEd25519Signer.fromSeedHex(SEED_HEX);
    const pub = await signer.publicKey();
    // Byte-identical to the test-vectors-v1.0 fixed_keypair (pynacl
    // SigningKey(seed).verify_key) — cross-language key-derivation pin.
    expect(Buffer.from(pub).toString("hex")).toBe(
      "207a067892821e25d770f1fba0c47c11ff4b813e54162ece9eb839e076231ab6",
    );
    const { envelope } = await buildEnvelope({ ...fixedInput(), signer });
    expect(envelope.public_key).toBe(
      "207a067892821e25d770f1fba0c47c11ff4b813e54162ece9eb839e076231ab6",
    );
  });

  it("generate() mints a working random keypair", async () => {
    const signer = LocalEd25519Signer.generate();
    const msg = utf8("hello");
    const sig = await signer.sign(msg);
    const pub = await signer.publicKey();
    expect(
      await ed25519Verify(
        Buffer.from(sig).toString("hex"),
        msg,
        Buffer.from(pub).toString("hex"),
      ),
    ).toBe(true);
  });
});
