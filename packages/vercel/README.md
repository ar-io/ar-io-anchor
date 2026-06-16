# @ar.io/anchor-vercel

Anchor your AI SDK calls as they run. Add one language-model middleware, and every `generateText` / `streamText` becomes a tamper-evident provenance record:

1. calls are **Merkle-batched on the hot path** — a whole request's calls are ONE write to Arweave (via [Turbo](https://ardrive.io/turbo), ar.io's upload service), not one per call,
2. every call still gets its **own standalone inclusion proof**, verifiable offline against the batch checkpoint,
3. prompts, settings, and outputs are **hashed locally and never uploaded** — the on-chain envelope carries only the hash (`ario.events/v1`, Minimal disclosure).

```bash
npm install @ar.io/anchor-vercel @ar.io/anchor ai
```

```ts
import { createAnchorer } from "@ar.io/anchor";
import { anchorMiddleware } from "@ar.io/anchor-vercel";
import { generateText, wrapLanguageModel } from "ai";
import { openai } from "@ai-sdk/openai";

const provenance = anchorMiddleware(createAnchorer()); // dev mode: zero config

const model = wrapLanguageModel({ model: openai("gpt-4o"), middleware: provenance });

await generateText({ model, prompt: "Summarize the Q2 incident reports" });

// End of request / run / process: flush and collect the proofs.
const receipts = await provenance.close();
for (const r of receipts) {
  console.log(r.envelope.event_id, "→ checkpoint", r.checkpointTxId, `leaf ${r.leafIndex}/${r.leafCount}`);
  // r.recordBytes is YOUR copy of what the hash commits to — retain it.
}
```

Production refuses auto-generated secrets — `createAnchorer({ environment: "production", signer, wallet })` per [`@ar.io/anchor`](https://github.com/ar-io/ar-io-anchor/tree/main/packages/anchor)'s structural gate. Dev proofs are permanently marked `environment: "dev"` inside the signed bytes.

## Grouping calls into a chain

The Vercel AI SDK middleware wraps the **model**, not the application, so — unlike [`@ar.io/anchor-langchain`](https://github.com/ar-io/ar-io-anchor/tree/main/packages/langchain), whose callbacks give a run *tree* — events here form a **flat chain** (`seq` + `prev_event_id`, committed in each record's metadata). You choose what groups them:

- **Correlation id (recommended for multi-call requests):** pass an id via `providerOptions.ario.chainKey`, and every call sharing it links in order — your request id, conversation id, or agent-loop id.

  ```ts
  await generateText({
    model,
    prompt,
    providerOptions: { ario: { chainKey: requestId } },
  });
  ```

- **Session fallback (zero-config):** with no id, all calls through one middleware instance link in emission order under a per-instance `session:<uuid>` chain.

Either way it's a flat sequence, not a tree: each record points at its predecessor inside individually signed, inclusion-proofed bytes, so a dropped event dangles, a reordered one disagrees on `seq`, and an edited one breaks its hash — **deletion-evident and reorder-evident** for the calls present.

## Event vocabulary

`vercel_ai.generate_start/_end/_error` and `vercel_ai.stream_start/_end/_error` — one event type per anchored operation (exported as `EVENT_TYPES`). Each operation gets exactly one terminal event: `_end` on success, `_error` on failure. For streams, a provider failure arrives in-band as an `error` part and anchors `stream_error`; chunks pass through untouched. A hard transport abort (the stream rejects with no error part) anchors neither terminal event — the `stream_start` stands and its missing completion is itself the signal (its chain pointer dangles).

## Controlling what the hash commits to

Nothing leaves your process either way — but the committed record is what you retain and what an auditor asks for. `mapPayload` runs before the hash is computed:

```ts
const provenance = anchorMiddleware(anchorer, {
  batch: { maxEvents: 64, flushOnIdle: 2_000 },     // batching knobs (first trigger wins)
  mapPayload: (e) => {
    if (e.type === "vercel_ai.generate_start") return null; // skip entirely
    return { ...e.payload, prompt: undefined };             // or redact fields
  },
});
```

Skipped events consume no sequence number — the committed chain stays gapless.

## Verifying a receipt

Offline, with the read-only [`@ar.io/proof`](https://www.npmjs.com/package/@ar.io/proof) kernel (`^0.2.0`, the full-family verifier) — no ar.io service in the trust path.

```bash
npm install @ar.io/proof
```

```ts
import { verifyEnvelope, verifyInclusion, hexToBytes } from "@ar.io/proof";

// Supply the retained record bytes and the envelope verifies green end-to-end:
// spec_version accepted + Ed25519 signature + payload binding.
const result = await verifyEnvelope(r.envelope, { payloadBytes: r.recordBytes });
result.ok;            // true — fully verified
result.signatureOk;   // true
result.payloadHashOk; // true (the committed record binds to payload_hash)

// And the event's leaf is provably in its checkpoint (RFC 9162):
const inclusionOk = await verifyInclusion(
  hexToBytes(r.leafHash), r.leafIndex, r.leafCount,
  r.auditPath.map(hexToBytes), hexToBytes(r.root),
);
```

**Without the record** (external commitment), `verifyEnvelope(r.envelope)` confirms the signature but reports **`payloadHashOk: null`** — *semantics-undetermined*, **not** a failure. Treat `null` as "supply the record to complete the proof," never as a pass and never as a tamper; a genuinely tampered record returns `payloadHashOk: false` with `ok: false`.

The checkpoint is fetched through any [ar.io gateway](https://gateways.ar.io) (`r.gatewayUrl`) and re-verified the same way — the gateway is delivery, never trust.

## Semantics

- **Hot path is synchronous.** Each call is one in-memory `batch.add()`; signing and the single upload happen at window flush. A model call never waits on the network for anchoring.
- **Errors are observed, never swallowed.** A failed call anchors a `*_error` event and the original error re-throws to your code unchanged.
- **Lifecycle is explicit.** `await provenance.close()` flushes and resolves all receipts; there are no hidden process-exit hooks. Long-lived middleware can `flush()` between requests.
- **Provenance never crashes the call.** A payload that fails to serialize is reported via `warn` and skipped — the model call still runs and returns.
- **Bounded memory on long-lived servers.** One middleware instance batches across requests (keep it long-lived to amortize writes), and it tracks a little chain state per distinct `chainKey`. That map is a bounded LRU (`maxTrackedChains`, default 10,000) — a correlation id evicted after long inactivity simply restarts at `seq 0` if it ever returns, so per-request ids never accumulate without bound.
- **Retention is yours.** External commitment means the receipt's `recordBytes` are the only copy of what the hash commits to. Store them — an envelope without its record proves a commitment existed, not what it said.
- Provenance, not endorsement: a verified history says *what happened* — never "safe" or "approved".

## License

MIT. The framework is a peer dependency; this package depends only on [`@ar.io/anchor`](https://github.com/ar-io/ar-io-anchor/tree/main/packages/anchor).
