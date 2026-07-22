# @ar.io/anchor-interchange

[Interchange](https://github.com/faremeter/interchange) already keeps your agent's audit trail in a signed git repository. This package adds the piece git can't provide: proof the history was never rewritten. Wrap the audit store you already pass to `createAgent`, and every record — allowed calls, **blocked calls**, and errors — is anchored to Arweave as it commits. A whole session is one write; every record keeps its own offline-verifiable inclusion proof; tool arguments and results are hashed locally and **never uploaded**.

At the end you hold one portable file an auditor can verify on any machine — no access to your repo, your agent, or this SDK.

## Quick start

```bash
npm install @ar.io/anchor-interchange @ar.io/anchor
```

```ts
import { createAnchorer } from "@ar.io/anchor";
import { anchoredAuditStore, signerFromCryptoProvider } from "@ar.io/anchor-interchange";

// The agent's existing Ed25519 identity signs the anchors too —
// no second key to custody.
const anchorer = createAnchorer({ signer: signerFromCryptoProvider(crypto) }); // dev mode

// The integration: wrap the store you already pass as env.audit.
const store = anchoredAuditStore(gitStore, anchorer);

// ... hand `store` to createAgent wherever an AuditStore goes; the agent
// runs unchanged, records anchor quietly behind each git commit ...

// End of run: collect proofs and write the one file that matters.
const receipts = [...(await store.close()).values()].flat();
const bundle = await anchorer.bundle(receipts);
await fs.writeFile("trace-bundle.json", JSON.stringify(bundle));
```

Whoever you send that file to runs:

```bash
npx @ar.io/proof verify trace-bundle.json
```

Green means: every record's signature, hash binding, and Merkle inclusion check out, offline. Edit one byte anywhere — in the bundle, or in the git repo it attests to — and verification fails.

## What you get

- **Deletion-evident sessions.** Each record points at its predecessor inside individually signed bytes, and carries Interchange's own reactor `seq`. Remove a record and the next one's pointer dangles; reorder and `seq` disagrees; edit and the hash breaks.
- **Denials as provable as actions.** Calls blocked by your authorize policy anchor as `interchange.tool_blocked` in the same chain — "the agent tried and was refused" becomes evidence.
- **Privacy by default, disclosure by choice.** On-chain there are only hashes. When you *want* the auditor to read the records, configure content retention and pass `disclose: true` (below) — the raw records travel inside the signed bundle, each bound to its committed hash.
- **Git stays the system of record.** The adapter delegates to the inner store first; if the git commit throws, nothing is anchored. Anchoring failures warn and never crash the agent.

## Let the auditor read the records (opt-in)

Configure retention on the anchorer and the bundle can embed the raw records itself:

```ts
import { createAnchorer, FsLogStore, FsSink } from "@ar.io/anchor";

const anchorer = createAnchorer({
  signer: signerFromCryptoProvider(crypto),
  sink: new FsSink("anchor/proofs.jsonl"),      // durable proof per event
  logStore: new FsLogStore("anchor/logs"),      // the exact committed bytes
});

// later:
const bundle = await anchorer.bundle(receipts, { disclose: true });
```

The verifier then also checks every disclosed record against its committed hash (`logs ✓`). Omit `disclose` and the same bundle verifies hash-only. See [retention in the core README](https://github.com/ar-io/ar-io-anchor/blob/main/packages/anchor/README.md#optionally-include-the-raw-logs-opt-in-default-off).

## Options you'll actually use

| Option | What it does |
|---|---|
| `mapPayload` | Trim/redact a record before its hash is computed (or return `null` to skip it — the chain stays gapless). |
| `onReceipts` | Persist each session's proofs wherever you like; fires on `flushSession`/`close` with cumulative receipts. |
| `resumeChains` | Restart-safe chains: hand back each session's last anchored event id on startup and the chain continues instead of gapping. Pairs with `onReceipts`. |
| `batch` | Batching knobs (`maxEvents`, `flushOnIdle`, …). Defaults suit bursty agent sessions: one write shortly after each burst. |

## Good to know

- **Typed against Interchange itself.** [`@intx/types`](https://www.npmjs.com/package/@intx/types) (>= 0.2) is a type-only peerDependency — the compiler checks your composition against the same types Interchange uses, and nothing from `@intx` loads at runtime. Runtime dependencies: exactly [`@ar.io/anchor`](https://github.com/ar-io/ar-io-anchor/tree/main/packages/anchor).
- **Production is gated.** Dev mode auto-generates identity and marks every proof `environment: "dev"` inside the signed bytes. Production requires an explicit signer and funded wallet — see the [core README](https://github.com/ar-io/ar-io-anchor/tree/main/packages/anchor).
- **Retention is yours.** A receipt's `recordBytes` are the only copy of what each hash commits to; keep receipts (or configure the `sink`/`logStore` above) alongside the git repo.
- **Provenance, not endorsement.** A verified history proves *what happened* — never "safe" or "approved".
- Wire format: profile [`ario.events/v1`](https://github.com/ar-io/ar-io-anchor/blob/main/docs/profile-ario.events-v1.md), family contract [`envelope-spec.md`](https://github.com/ar-io/ar-io-proof/blob/main/specs/envelope-spec.md). Event types: `interchange.tool_call` / `interchange.tool_blocked` / `interchange.error`.

## License

MIT.
