# Design options — `@ar.io/anchor-vercel` event chaining

> **Status: proposed — design options for coordinator review.** Pre-build design note for the Vercel AI SDK adapter ([#3](https://github.com/ar-io/ar-io-anchor/issues/3)), the documented fast-follow to `@ar.io/anchor-langchain`. Resolves the one non-mechanical decision flagged in #3 before any code is written: **what groups Vercel events into a verifiable chain**, given the seam has no run tree. Everything else in the adapter is copy-paste from the langchain package (proven). No code, no wire-format change; the `ario.events/v1` profile is unaffected. Decision owner: coordinator.

## 1. Why this needs a decision (and langchain didn't)

The langchain adapter's differentiator — the one that won it the framework pick — is the **run tree**: LangChain's callbacks carry `runId`/`parentRunId` for every step, so the adapter commits a deletion/reorder-evident tree (`root_run_id` + per-root `seq` + `prev_event_id`) inside each record's `metadata` section. That linkage was free because the framework hands it to us.

The Vercel AI SDK seam is structurally different. The adapter binds a **`LanguageModelMiddleware`** (`wrapLanguageModel`, `specificationVersion: "v3"`, proven in `spikes/lane-4b/spike-vercel.mjs`): `wrapGenerate` wraps one model call, `wrapStream` wraps one streamed call. The middleware wraps the **model**, not the application — so there is **no app-level run id and no parent/child tree** threaded into the seam. A multi-step agentic loop (tool call → continuation) arrives as several independent middleware invocations with nothing built-in linking them.

So the question langchain answered for free is open here: **what is the chain key — the thing `seq` + `prev_event_id` are scoped to?** This doc does not change the *mechanism* (metadata-level linkage in the committed record, identical to langchain — batched leaves are not core-`chain`-able by design, profile [§5](profile-ario.events-v1.md)/§6). It only chooses the grouping.

## 2. What the seam actually exposes (verify-at-build, do not assume)

Grounded in the spike (`ai@6.0.203`); the build lane MUST re-confirm against the pinned `ai` version, because this is the load-bearing uncertainty:

- `wrapGenerate`/`wrapStream` receive `{ doGenerate|doStream, params, model }`. `params` carries the prompt, settings, and **`providerOptions`** (a caller-controlled pass-through object) — the natural channel for a caller-supplied correlation id.
- The SDK does **not** (as of the spike) thread a stable per-`generateText`-call id into middleware that the adapter can read to auto-correlate the steps of one logical call. **If the build lane finds the pinned `ai` version does expose one** (e.g. via telemetry `functionId` / a step/call id), Option B's auto-correlation becomes viable without caller cooperation — re-evaluate then.
- Stream completion is observable (the spike anchors `stream_end` from a `TransformStream` flush), so per-call start/end pairing is always available regardless of the grouping choice.

## 3. The options

The choice is the **grouping key** for the metadata chain. All three keep langchain's `mapPayload` redaction hook, explicit `close()`, provenance-never-throws, and primitive-level verify story unchanged.

| Option | Chain key | What links | Honesty cost |
|---|---|---|---|
| **A — Singletons** | none | each generate/stream is an unchained event (optionally a 2-event start→end local pair) | **Drops the ordering differentiator entirely.** Only the batcher checkpoint chain witnesses the window; no cross-call sequence. Cheapest, weakest. |
| **B — Per-instance session chain** | the adapter instance (one wrapped model / process lifetime) | every event from this adapter in emission order, flat (`seq` + `prev_event_id`), no parent/child | A flat session log, not a tree. Honest and useful, but conflates concurrent logical requests sharing one model instance into one interleaved chain. |
| **C — Caller-supplied correlation id** | an id the caller passes (via `providerOptions` or a per-call adapter option) | events sharing that id, in emission order | Recovers logical request/conversation grouping the seam can't see — **but only when the caller cooperates.** Needs a documented fallback when absent. |

## 4. Recommendation: **C with B as the no-id fallback**

Ship **C layered over B**: the adapter reads an optional correlation id from `providerOptions` (key TBD, e.g. `arioChainKey`); when present, events sharing it form a chain; when absent, they fall back to the per-instance session chain (B). Reject A as a standalone default — losing ordering surrenders the very property (deletion/reorder-evidence) that makes the langchain adapter compelling, and the fallback already costs nothing.

Why this shape:

- **It degrades honestly.** Zero-config users get a real, ordered session chain (B); users who thread a request/conversation id get logical grouping (C) — neither path is a dead end, and the README can state exactly what each guarantees.
- **It mirrors langchain's posture without overclaiming.** langchain's tree is richer because the framework affords it; the doc and copy must say plainly that the Vercel chain is a **flat sequence**, not a tree — same `seq`/`prev_event_id` mechanism, weaker source signal. No "run tree" language for Vercel.
- **It needs no core touch.** Pure metadata-level linkage in the committed record, exactly as langchain shipped. If §2's verify-at-build turns up a native per-call-tree id, B can be upgraded from per-instance to per-logical-call auto-correlation — an additive improvement, not a redesign.

The one sub-decision for the coordinator: the `providerOptions` key name and whether C is opt-in (recommended) or attempts auto-correlation first.

## 5. What is NOT in question (carried from langchain, unchanged)

- **Packaging:** `ai` as a `peerDependency` (range TBD at build — mirror the langchain `^1.0.0` 0.x-exclusion reasoning against `ai`'s release history); runtime deps adapter→core only; seam-6 spy-anchorer tests (zero crypto/network) + a gated live smoke; **no npm publish without coordinator green light.**
- **Batcher on the hot path:** each middleware invocation is one synchronous `batch.add()`; one checkpoint write per window; per-event inclusion receipts. The stream path anchors `stream_end` at flush.
- **Disclosure:** `ario.events/v1`, Minimal — prompts/outputs hashed locally, never uploaded; `mapPayload` controls the committed record.
- **Verify story:** primitive-level (binding / `signatureOk` / RFC-9162 inclusion) until kernel-ratify republishes `@ar.io/proof` with `ario.events/v1` accepted — **same gate as langchain**; no `verifyEnvelope`-green claims in the debut.
- **Vocabulary:** `vercel_ai.generate_start/_end`, `vercel_ai.stream_start/_end` (+ `_error` variants) under profile [§4](profile-ario.events-v1.md) (adapter-namespaced, additive-minor).

## 6. Open question for the build lane

The §2 uncertainty is the gate on Option B's ceiling: does the pinned `ai` version expose a stable id linking the steps of one logical `generateText`/`streamText` call to middleware? Confirm empirically (not from memory) at build kickoff. If yes → B auto-correlates logical calls and C becomes a refinement; if no → ship C-over-flat-B as recommended. Everything else above stands either way.
