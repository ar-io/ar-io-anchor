# @ar.io/anchor-interchange

Anchor your [Interchange](https://github.com/faremeter/interchange) agent's audit trail as it commits. Interchange already writes every tool call to a signed, git-backed audit store; decorate that store and every audit record — allowed calls, blocked calls, and errors — also becomes a tamper-evident provenance record **outside** the repo it attests to:

1. records are **Merkle-batched per session** — a whole agent session is ONE write to Arweave (via [Turbo](https://ardrive.io/turbo), ar.io's upload service), not one per tool call,
2. every record still gets its **own standalone inclusion proof**, verifiable offline against the session's batch checkpoint,
3. tool arguments and results are **hashed locally and never uploaded** — the on-chain envelope carries only the hash (`ario.events/v1`, Minimal disclosure) — and anchors are signed with the **agent's existing Ed25519 identity key**, the same key that signs its git commits.

Git remains the system of record; anchoring rides behind it. What the anchor adds is evidence an auditor can check **without trusting the repo, the agent, or its operator**: a git history can be rewritten by whoever holds the keys — an anchored checkpoint on Arweave cannot.

```bash
npm install @ar.io/anchor-interchange @ar.io/anchor
```

```ts
import { createAnchorer } from "@ar.io/anchor";
import { anchoredAuditStore, signerFromCryptoProvider } from "@ar.io/anchor-interchange";

// The agent's existing Ed25519 identity (Interchange's CryptoProvider)
// signs the anchors too — no second key to custody.
const anchorer = createAnchorer({ signer: signerFromCryptoProvider(crypto) }); // dev mode

// Decorate the audit store; hand the decorated store to Interchange
// wherever an AuditStore goes (the sidecar composition layer).
const store = anchoredAuditStore(gitStore, anchorer);

// ... the agent runs; every committed audit record is anchored behind it ...

// End of process: flush and collect the proofs, per session.
const bySession = await store.close();
for (const [sessionId, receipts] of bySession) {
  console.log(sessionId, "→", receipts.length, "records, checkpoint", receipts[0]?.checkpointTxId);
  // r.recordBytes is YOUR copy of what each hash commits to — retain it.
}
```

Production refuses auto-generated secrets — `createAnchorer({ environment: "production", signer, wallet, subject })` per [`@ar.io/anchor`](https://github.com/ar-io/ar-io-anchor/tree/main/packages/anchor)'s structural gate (an explicit signer and funded wallet are required; the CryptoProvider adapter satisfies the signer half). Dev proofs are permanently marked `environment: "dev"` inside the signed bytes.

## The session chain is the record

Interchange's reactor stamps every audit record with a monotonic `seq`. The adapter commits that — plus its own per-session event chain — inside every hash-committed record's metadata:

```json
"interchange": {
  "session_id": "…",     // the Interchange session
  "call_id": "…",        // the tool call (null for error records)
  "seq": 3,              // Interchange's reactor-owned sequence, passed through
  "tool": "shell_exec",  // the tool invoked (null for error records)
  "blocked": true,       // whether authorization prevented execution
  "prev_event_id": "…"   // the previous event's envelope event_id in this session
}
```

Each record points at its predecessor, and every pointer lives inside individually signed, inclusion-proofed bytes. Drop a record and the next one's pointer dangles; reorder them and `seq` disagrees; edit one and its hash breaks. Blocked calls and errors participate in the same chain — **an agent's denials are as tamper-evident as its actions.**

## Event vocabulary

`interchange.tool_call` (allowed calls), `interchange.tool_blocked` (calls authorization prevented, i.e. `authz.blocked === true`), `interchange.error` (runtime error records) — exported as `EVENT_TYPES`.

## Controlling what the hash commits to

Nothing leaves your process either way — but the committed record is what you must retain and what an auditor will ask for. `mapPayload` runs before the hash is computed:

```ts
const store = anchoredAuditStore(gitStore, anchorer, {
  batch: { maxEvents: 64, flushOnIdle: 2_000 },  // batching knobs (first trigger wins)
  mapPayload: (e) => {
    if (e.tool === "scratchpad_write") return null;            // skip entirely
    if (e.tool === "vault_read") return { ...e.payload, arguments: "[redacted]" }; // redact
    return e.payload;
  },
  onReceipts: (sessionId, receipts) => {
    // Persist proofs wherever you like (e.g. state/anchor/{sessionId}/ in
    // the same git repo). The adapter itself does no file I/O.
  },
});
```

Skipped records advance no chain pointer — the committed chain stays gapless.

## Verifying

Collect the receipts, serialize them into ONE signed, portable `trace-bundle.json`, and hand it to an auditor — they verify the whole thing (every record's signature + payload binding + Merkle inclusion, offline) with **one command** and the read-only [`@ar.io/proof`](https://www.npmjs.com/package/@ar.io/proof) (no write SDK in the trust path):

```ts
const bySession = await store.close();
const receipts = bySession.get(sessionId)!;
const bundle = await anchorer.bundle(receipts); // signed with the agent's own key — zero ceremony
await fs.writeFile("trace-bundle.json", JSON.stringify(bundle, null, 2));
```

```bash
npx @ar.io/proof verify trace-bundle.json
# optionally re-fetch each checkpoint on-chain to confirm it's anchored:
npx @ar.io/proof verify trace-bundle.json https://arweave.net,https://permagate.io
```

Want the auditor to read the actual tool calls — the raw record bytes, not just verify their hashes? Pass `anchorer.bundle(receipts, { disclose })` (keyed by `eventId`) to embed selected records' bytes inside the signed bundle — opt-in, default off, on-chain footprint unchanged. See [disclosure in the core README](https://github.com/ar-io/ar-io-anchor/blob/main/packages/anchor/README.md#optionally-include-the-raw-logs-opt-in-default-off).

A single receipt also verifies by hand with `verifyEnvelope(r.envelope, { payloadBytes: r.recordBytes })` and `verifyInclusion(...)` — see the [`@ar.io/anchor-langchain` README](https://github.com/ar-io/ar-io-anchor/tree/main/packages/langchain#verifying) for the full manual-verification walkthrough; the receipt shapes are identical.

## Semantics

- **Hot path is synchronous-cheap.** Each committed record is one in-memory `batch.add()`; signing and the single upload happen at window flush. A tool call never waits on the network.
- **Git commits first.** `commitAudit`/`commitErrors` delegate to the inner store before anchoring anything — if the git commit throws, nothing is anchored. The adapter never attests to a record that was not persisted.
- **Lifecycle is explicit.** `await store.close()` flushes every session and resolves all receipts; `flushSession(sessionId)` checkpoints one session without closing it. There are no hidden process-exit hooks. `onReceipts` fires at both, with the session's cumulative receipts.
- **Provenance never crashes the agent.** A record that fails to serialize (circular reference, BigInt) — or a throwing `mapPayload` — is reported via `warn` and skipped; the run continues and the chain stays gapless.
- **Retention is yours.** External commitment means the receipt's `recordBytes` are the only copy of what each hash commits to. Interchange's git repo already retains the records — the receipts (and their envelopes) are what you must keep alongside it.
- **Restarts don't break the chain.** Long-lived hosts persist each session's last receipt `eventId` (via `onReceipts`) and hand the map back as `resumeChains` on startup — the resumed session's first record then points at the pre-restart head instead of opening a fresh chain.
- Provenance, not endorsement: a verified history says *what happened* — never "safe" or "approved".

## Typed against Interchange itself

The adapter is typed directly against [`@intx/types`](https://www.npmjs.com/package/@intx/types) (a **peerDependency**, `^0.2.2`): `commitAudit` takes Interchange's own `AuditRecord[]`, the decorated store *is* an `@intx/types/runtime` `AuditStore`, and `signerFromCryptoProvider` adapts their `CryptoProvider`. There is no adapter-local mirror of Interchange's shapes to drift out of date — the compiler checks your composition against the same types Interchange itself uses, at whatever `@intx/types` version your project has installed.

The imports are type-only, so nothing from `@intx` loads at runtime: this package's runtime dependency tree stays exactly [`@ar.io/anchor`](https://github.com/ar-io/ar-io-anchor/tree/main/packages/anchor). One runtime gate remains (`test/intx-compat.test.ts`): the canonical fixtures our tests anchor are validated against Interchange's own arktype schemas, so an upstream tightening the static types can't express fails in this repo's CI instead of in a consumer's audit trail.

Earlier versions (≤ 0.1.0) shipped duck-typed structural mirrors instead, because `@intx/*` 0.1.x published raw TypeScript source npm consumers couldn't load. Interchange 0.2 ships compiled JS + declarations, which removed the reason for the indirection.

## License

MIT. This package depends only on [`@ar.io/anchor`](https://github.com/ar-io/ar-io-anchor/tree/main/packages/anchor) at runtime; `@intx/types` is a type-only peer dependency.
