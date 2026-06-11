# @ar.io/anchor

Anchor-at-write-time for the ar.io verification stack: hash your data locally, sign a [Verifiable Event Envelope](https://github.com/ar-io/ar-io-proof/blob/main/specs/envelope-spec.md) under the `ario.events/v1` profile, and upload it straight to Arweave via Turbo — no relay, no SDK bloat, raw bytes never leave your system.

```ts
import { createAnchorer } from "@ar.io/anchor";

// Dev mode: zero config. Auto identity + wallet, Turbo free tier.
// Proofs are permanently marked environment:"dev" inside the signed bytes.
const ario = createAnchorer();

const receipt = await ario.anchor({
  type: "event",
  data: fileBytes,            // or a string, or an AsyncIterable (streams),
  // contentHash: "...",      // or a pre-computed sha256 — exactly one
  ref: "s3://bucket/key",     // optional locator
  metadata: { approver: "alice" },
  chain: "orders",            // optional per-key hash chain
});

receipt.txId;          // Arweave tx id (Turbo-accepted = resolved)
receipt.envelope;      // the signed, Minimal-disclosure envelope
receipt.recordBytes;   // RETAIN THESE — the committed event record
receipt.explorerUrl;
```

Production structurally refuses auto-generated secrets:

```ts
createAnchorer({
  environment: "production", // THROWS without explicit credentials
  signer,                    // Signer interface — never raw key bytes
  wallet,                    // funded data-item wallet (Solana ed25519 default)
  subject: { type: "producer", producer_id: "acme-app" },
});
```

## Guarantees

- **Local hashing only.** `data` is hashed in-process (streams supported); only the signed envelope (a few hundred bytes) is uploaded.
- **Minimal disclosure.** The on-chain envelope carries no event type, no subject, no chain pointer — those live in the hash-committed record you retain.
- **Dev proofs are cryptographically dev.** `environment` sits inside the signed scope; a dev proof can never be presented as production evidence.
- **Verification is a separate, read-only package** — [`@ar.io/proof`](https://www.npmjs.com/package/@ar.io/proof). This package contains the write path only.

## Conformance

Byte-for-byte against the family corpus (`ar-io-proof` `test-vectors`); ANS-104 output byte-pinned vs arbundles and re-verified by an independent Python parser in CI. See the [profile spec](../../docs/profile-ario.events-v1.md).
