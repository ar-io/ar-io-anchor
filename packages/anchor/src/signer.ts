// Local Ed25519 signer — the in-process implementation of the Signer plug
// point. Dev mode auto-generates one; tests use a fixed seed. Production
// custody (Vault, KMS via the signature_alg expansion path) implements the
// same interface in adapter packages — core never requires raw key bytes.

import * as ed from "@noble/ed25519";

import type { Signer } from "./types.js";

// @noble/ed25519 needs SHA-512; wire it to WebCrypto exactly as @ar.io/proof
// does (no @noble/hashes dependency). Assigning is idempotent.
ed.etc.sha512Async = async (...msgs: Uint8Array[]): Promise<Uint8Array> =>
  new Uint8Array(
    await crypto.subtle.digest(
      "SHA-512",
      ed.etc.concatBytes(...msgs) as unknown as BufferSource,
    ),
  );

export class LocalEd25519Signer implements Signer {
  // 32-byte RFC 8032 seed (what pynacl calls SigningKey(seed) and Go calls
  // the private key's seed half).
  private constructor(private readonly seed: Uint8Array) {
    if (seed.length !== 32) {
      throw new Error(`Ed25519 seed must be 32 bytes, got ${seed.length}`);
    }
  }

  static fromSeed(seed: Uint8Array): LocalEd25519Signer {
    return new LocalEd25519Signer(seed);
  }

  static fromSeedHex(seedHex: string): LocalEd25519Signer {
    if (!/^[0-9a-f]{64}$/.test(seedHex)) {
      throw new Error("Ed25519 seed must be 64 lowercase hex chars");
    }
    const seed = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      seed[i] = Number.parseInt(seedHex.slice(i * 2, i * 2 + 2), 16);
    }
    return new LocalEd25519Signer(seed);
  }

  static generate(): LocalEd25519Signer {
    return new LocalEd25519Signer(ed.utils.randomPrivateKey());
  }

  async publicKey(): Promise<Uint8Array> {
    return ed.getPublicKeyAsync(this.seed);
  }

  async sign(bytes: Uint8Array): Promise<Uint8Array> {
    return ed.signAsync(bytes, this.seed);
  }
}
