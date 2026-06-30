# @ar.io/anchor

Anchor-at-write-time for the ar.io verification stack: hash your data locally, sign a [Verifiable Event Envelope](https://github.com/ar-io/ar-io-proof/blob/main/specs/envelope-spec.md) under the `ario.events/v1` profile, and anchor it to ar.io — no relay, no SDK bloat, raw bytes never leave your system.

**Write** through Turbo — ar.io's upload service. **Read** it back through any ar.io gateway — turbo-gateway.com, or any of the others at [gateways.ar.io](https://gateways.ar.io); you're never locked to one provider. Underneath, it's stored permanently on Arweave.

```bash
npm install @ar.io/anchor
```

```ts
import { createAnchorer } from "@ar.io/anchor";

// Dev mode: zero config. Auto identity + wallet; small uploads are free on Turbo.
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

receipt.txId;          // ar.io transaction id (resolved once Turbo accepts the upload)
receipt.envelope;      // the signed, Minimal-disclosure envelope
receipt.recordBytes;   // RETAIN THESE — the committed event record
receipt.gatewayUrl;    // resolve on any ar.io gateway (gateways.ar.io)
```

## Batching

High-frequency events (LLM steps, pipeline records): one ar.io write per window, while every event keeps its own offline-verifiable inclusion proof.

```ts
const batch = ario.batch({
  maxEvents: 100,     // flush when full…
  maxAge: 60_000,     // …or 60s after the first buffered event…
  flushOnIdle: 5_000, // …or 5s after the last add. First trigger wins.
});

const receipt = await batch.add({ data: JSON.stringify(step) }).receipt();
// → { checkpointTxId, root, leafHash, leafIndex, auditPath, envelope, recordBytes, ... }

await ario.close(); // explicit flush — call it on shutdown; nothing is flushed for you
```

`add()` is synchronous (bytes/string/pre-computed hash — no streams here). A batch of one is valid. With the default in-memory buffer a crash loses buffered *proofs*, never data — every event is re-anchorable from your system.

## Bundle a whole trace (one portable file)

Collect a set of receipts and serialize them into ONE signed, self-verifying `ario.evidence/v1` bundle (`body_type: ario.anchor.trace/v1`) with `ario.bundle()`. The wrapper is signed by your anchorer's own key — the same key the receipts' envelopes carry, so the call site needs zero signer handling; the bundle carries every event's signed envelope + committed record + inclusion proof, de-duplicating the shared checkpoint(s).

```ts
const receipts = await Promise.all(handles.map((h) => h.receipt()));
const bundle = await ario.bundle(receipts); // signed with the anchorer's own key — zero ceremony
await fs.writeFile("trace-bundle.json", JSON.stringify(bundle, null, 2));
```

Need an explicit key, or to override the issuer/gateway? The standalone advanced form is `toEvidenceBundle(receipts, { signer, issuer })` (also from `@ar.io/anchor`) — `ario.bundle()` is the same call wired to your anchorer's own signer with a sensible default issuer.

### Optionally include the raw logs (opt-in, default off)

By default a bundle discloses **nothing semantic** — it carries hashes and on-chain locations, never your raw bytes, and that's the whole point of minimal disclosure. Sometimes, though, you *want* one self-contained file an auditor can open and read: the raw logs **and** their on-chain proofs together. Pass `disclose`, keyed by `eventId`, with the original bytes (the receipt never retained them, so you supply them back):

```ts
const bundle = await ario.bundle(receipts, {
  disclose: { [receipts[0].eventId]: rawLogBytes }, // Uint8Array | string (UTF-8)
});
```

Each disclosed event embeds its bytes (lowercase hex) **inside the signed body**, so the disclosure is covered by `body_hash` and tamper-evident like everything else; `sha256(bytes)` is asserted equal to the event's committed `content_hash` at assembly time, and a mismatch throws. This is purely a property of the **file you hand out** — your **on-chain footprint is unchanged** (the envelope still carries only the hash), and events you don't list stay minimal. Disclose all, some, or none, per event.

## Verifying

Hand the trace bundle to an auditor; they verify the whole thing — every event's signature + payload binding + Merkle inclusion, offline — with **one command** and the read-only [`@ar.io/proof`](https://www.npmjs.com/package/@ar.io/proof) (no write SDK in the trust path):

```bash
npx @ar.io/proof verify trace-bundle.json
# optionally re-fetch each checkpoint on-chain to confirm it's anchored:
npx @ar.io/proof verify trace-bundle.json https://arweave.net,https://permagate.io
```

It prints a per-event + rollup verdict and exits on a pinned code (`0` verified · `1` failed · `2` malformed · `3` gateway-unavailable); the producer's asserted verdict is shown but never trusted (the verdict is recomputed from the body). A **withheld** record surfaces as semantics-undetermined (`~`), not a failure. Any raw bytes you **disclosed** (above) are checked too — the verifier recomputes their hash, confirms it equals the event's committed `content_hash`, and marks the event `logs ✓` (`--logs <file>` does the same for logs that travel alongside a minimal bundle). The same CLI also verifies the agent's `ario.agent.proof/v1` inclusion bundles (it sniffs `spec_version`).

> **Live:** the bundle emit (`ario.bundle()` / `toEvidenceBundle`) ships in `@ar.io/anchor` ≥ 0.1.3 and the `npx @ar.io/proof verify` CLI in `@ar.io/proof` ≥ 0.2.2. The `@ar.io/proof` primitives below remain available for manual/advanced verification.

A single envelope still verifies by hand from any ar.io gateway (`https://<gateway>/raw/<txId>`, e.g. `turbo-gateway.com`) with your retained `recordBytes`:

```ts
import { ed25519Verify, jcs, sha256Hex, utf8, verifyInclusion, hexToBytes } from "@ar.io/proof";

const { signature, ...preSignature } = receipt.envelope;
await ed25519Verify(signature, utf8(jcs(preSignature)), receipt.envelope.public_key); // true
(await sha256Hex(receipt.recordBytes)) === receipt.envelope.payload_hash;             // true
```

See the runnable [examples](https://github.com/ar-io/ar-io-anchor/tree/main/examples).

## Production

Production structurally refuses auto-generated secrets — it throws unless you pass all three:

```ts
import { createAnchorer, LocalEd25519Signer, SolanaWalletSigner } from "@ar.io/anchor";

const ario = createAnchorer({
  environment: "production",
  // Identity key (signs envelopes). Any { publicKey(), sign() } works —
  // file seed shown; Vault/KMS adapters implement the same interface.
  signer: LocalEd25519Signer.fromSeedHex(process.env.ANCHOR_IDENTITY_SEED!),
  // Funding wallet (pays Turbo) — a different key, Solana ed25519 default.
  wallet: new SolanaWalletSigner(LocalEd25519Signer.fromSeedHex(process.env.ANCHOR_WALLET_SEED!)),
  subject: { type: "producer", producer_id: "acme-app" },
});
```

The two keys are deliberately separate: identity (who signed) vs money (who pays). Fund the wallet with Turbo Credits at https://turbo.ardrive.io.

## Errors

All errors carry a machine-checkable `code`:

| Class (`code`) | When | Do |
|---|---|---|
| `FundingExhaustedError` (`FUNDING_EXHAUSTED`) | Turbo 402 — wallet out of funds | Fund the wallet; the message includes instructions. Not retryable as-is. |
| `UploadFailedError` (`UPLOAD_FAILED`) | 5xx/429/network, retries exhausted | Transient — safe to retry the same `anchor()` call. |
| `UploadRejectedError` (`UPLOAD_REJECTED`) | Terminal 4xx from Turbo | Inspect the detail; retrying the same bytes won't help. |
| `TxIdMismatchError` (`TXID_MISMATCH`) | Upstream returned a TX ID that doesn't match the signature-derived one | Should never happen with an honest upstream — treat the upload as suspect. |
| `ProductionConfigError` (`PRODUCTION_CONFIG`) | Production mode without explicit signer/wallet/subject | Supply the missing credentials; dev secrets cannot reach production. |

A failed **batch** window rejects only that window's `receipt()` promises — the chain head is untouched and the next window proceeds; re-`add` the events to re-anchor them.

## Guarantees

- **Local hashing only.** `data` is hashed in-process (streams supported); only the signed envelope (a few hundred bytes) is uploaded.
- **Minimal disclosure.** The on-chain envelope carries no event type, no subject, no chain pointer — those live in the hash-committed record you retain.
- **Dev proofs are cryptographically dev.** `environment` sits inside the signed scope; a dev proof can never be presented as production evidence.
- **Verification is a separate, read-only package** — [`@ar.io/proof`](https://www.npmjs.com/package/@ar.io/proof). This package contains the write path only.

## Conformance

Byte-for-byte against the family corpus (`ar-io-proof` `test-vectors-v1.1`); ANS-104 output byte-pinned vs arbundles and re-verified by an independent Python parser in CI. See the [profile spec](https://github.com/ar-io/ar-io-anchor/blob/main/docs/profile-ario.events-v1.md).
