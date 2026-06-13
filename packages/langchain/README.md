# @ar.io/anchor-langchain

Anchor your agent's run tree as it executes. Add one callback handler, and every chain, chat-model, LLM, tool, and retriever step becomes a tamper-evident provenance record:

1. events are **Merkle-batched on the hot path** — a whole agent session is ONE write to Arweave (via [Turbo](https://ardrive.io/turbo), ar.io's upload service), not one per step,
2. every event still gets its **own standalone inclusion proof**, verifiable offline against the batch checkpoint,
3. prompts, outputs, and tool I/O are **hashed locally and never uploaded** — the on-chain envelope carries only the hash (`ario.events/v1`, Minimal disclosure).

```bash
npm install @ar.io/anchor-langchain @ar.io/anchor @langchain/core
```

```ts
import { createAnchorer } from "@ar.io/anchor";
import { anchorCallbacks } from "@ar.io/anchor-langchain";

const provenance = anchorCallbacks(createAnchorer()); // dev mode: zero config

// One line of integration: pass it like any LangChain callback.
const answer = await agent.invoke(
  { input: "Summarize the Q2 incident reports" },
  { callbacks: [provenance] },
);

// End of run / request / process: flush and collect the proofs.
const receipts = await provenance.close();
for (const r of receipts) {
  console.log(r.envelope.event_id, "→ checkpoint", r.checkpointTxId, `leaf ${r.leafIndex}/${r.leafCount}`);
  // r.recordBytes is YOUR copy of what the hash commits to — retain it.
}
```

Production refuses auto-generated secrets — `createAnchorer({ environment: "production", signer, wallet })` per [`@ar.io/anchor`](https://github.com/ar-io/ar-io-anchor/tree/main/packages/anchor)'s structural gate. Dev proofs are permanently marked `environment: "dev"` inside the signed bytes.

## The run tree is the record

LangChain's callbacks carry `runId`/`parentRunId` for every step. The handler commits that linkage — plus its own per-run event chain — inside every hash-committed record's metadata:

```json
"langchain": {
  "run_id": "…",          // this step
  "parent_run_id": "…",   // its parent in the run tree
  "root_run_id": "…",     // the top-level invocation it belongs to
  "seq": 3,               // its ordinal within that root run
  "prev_event_id": "…"    // the previous event's envelope event_id
}
```

Each record points at its predecessor, and every pointer lives inside individually signed, inclusion-proofed bytes. Drop an event and the next one's pointer dangles; reorder them and `seq` disagrees; edit one and its hash breaks. The result: a **deletion-evident, reorder-evident tree of everything the agent did**, reconstructable offline from the receipts alone.

## Event vocabulary

`langchain.chain_start/_end/_error`, `langchain.chat_model_start`, `langchain.llm_start/_end/_error`, `langchain.tool_start/_end/_error`, `langchain.retriever_start/_end` — one event type per anchored callback (exported as `EVENT_TYPES`).

## Controlling what the hash commits to

Nothing leaves your process either way — but the committed record is what you must retain and what an auditor will ask for. `mapPayload` runs before the hash is computed:

```ts
const provenance = anchorCallbacks(anchorer, {
  batch: { maxEvents: 64, flushOnIdle: 2_000 },          // batching knobs (first trigger wins)
  mapPayload: (e) => {
    if (e.type === "langchain.retriever_end") return null; // skip entirely
    return { ...e.payload, prompts: undefined };           // or redact fields
  },
});
```

Skipped events consume no sequence number — the committed chain stays gapless.

## Verifying a receipt

Offline, with the read-only [`@ar.io/proof`](https://www.npmjs.com/package/@ar.io/proof) kernel — no ar.io service in the trust path. Three primitive checks per event:

```ts
import { sha256Hex, verifyEnvelope, verifyInclusion, hexToBytes } from "@ar.io/proof";

const bindingOk = (await sha256Hex(r.recordBytes)) === r.envelope.payload_hash; // record → hash
const { signatureOk } = await verifyEnvelope(r.envelope);                       // Ed25519 over the envelope
const inclusionOk = await verifyInclusion(                                      // RFC 9162: leaf ∈ checkpoint
  hexToBytes(r.leafHash), r.leafIndex, r.leafCount,
  r.auditPath.map(hexToBytes), hexToBytes(r.root),
);
```

The checkpoint itself is fetched through any [ar.io gateway](https://gateways.ar.io) (`r.gatewayUrl`) and re-verified the same way — the gateway is delivery, never trust.

## Semantics

- **Hot path is synchronous.** Each callback is one in-memory `batch.add()`; signing and the single upload happen at window flush. An agent step never waits on the network.
- **Lifecycle is explicit.** `await provenance.close()` flushes and resolves all receipts; there are no hidden process-exit hooks. Long-lived handlers can `flush()` between requests.
- **Provenance never crashes the agent.** A payload that fails to serialize is reported via `warn` and skipped — the run continues.
- **Retention is yours.** External commitment means the receipt's `recordBytes` are the only copy of what the hash commits to. Store them (DB row, object store, log archive) — an envelope without its record proves a commitment existed, not what it said.
- Provenance, not endorsement: a verified history says *what happened* — never "safe" or "approved".

## License

MIT. The framework is a peer dependency; this package depends only on [`@ar.io/anchor`](https://github.com/ar-io/ar-io-anchor/tree/main/packages/anchor).
