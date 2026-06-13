// @ar.io/anchor-langchain — anchor your agent's run tree as it executes.
// One LangChain.js callback handler turns every chain / chat-model / LLM /
// tool / retriever step into a provenance event on @ar.io/anchor's Merkle
// batcher: N events per window become ONE Arweave write, and every event
// keeps its own standalone, offline-verifiable inclusion proof.
//
// The differentiator this adapter leans into is the RUN TREE. LangChain's
// callbacks carry runId/parentRunId for every step; the adapter commits that
// linkage — plus its own per-run event chain (seq + prev_event_id) — inside
// each event's hash-committed record. The result is a deletion-evident,
// reorder-evident tree of everything the agent did, reconstructable and
// verifiable offline from the receipts alone.
//
// Disclosure (ario.events/v1, Minimal): prompts, outputs, and tool I/O go
// into the committed record, which is hashed locally and handed back to YOU
// via the receipt — the on-chain envelope carries only the hash. Nothing
// semantic ever leaves your process. Retaining the records is your
// obligation (external commitment); `mapPayload` lets you trim or redact
// what the hash commits to before it is computed.

import type { Anchorer, Batch, BatchOptions, InclusionReceipt } from "@ar.io/anchor";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";

// The adapter's event_type vocabulary (profile §4: adapter-namespaced,
// additive-minor). One type per LangChain callback this handler anchors.
export const EVENT_TYPES = [
  "langchain.chain_start",
  "langchain.chain_end",
  "langchain.chain_error",
  "langchain.chat_model_start",
  "langchain.llm_start",
  "langchain.llm_end",
  "langchain.llm_error",
  "langchain.tool_start",
  "langchain.tool_end",
  "langchain.tool_error",
  "langchain.retriever_start",
  "langchain.retriever_end",
] as const;

export type LangChainEventType = (typeof EVENT_TYPES)[number];

// What `mapPayload` sees for every event, before anything is committed.
export interface LangChainAnchorEvent {
  type: LangChainEventType;
  // The semantic content (prompts/messages/outputs/tool I/O). Whatever this
  // is after mapPayload runs is JSON-serialized and hash-committed.
  payload: Record<string, unknown>;
  runId: string;
  parentRunId?: string;
  // Run-tree linkage the adapter computes (also committed, in metadata).
  rootRunId: string;
  seq: number;
  prevEventId: string | null;
  eventId: string;
}

export interface AnchorCallbacksOptions {
  // Passed to anchorer.batch(). Default: { maxEvents: 64, flushOnIdle: 2000,
  // name: "langchain" } — bursty agent sessions flush shortly after the
  // burst; a hard cap bounds the window.
  batch?: BatchOptions;
  // Trim/redact/transform the payload before it is hash-committed. Return
  // null to skip anchoring the event entirely. The run-tree linkage in
  // metadata is not affected — only the committed content.
  mapPayload?: (event: LangChainAnchorEvent) => Record<string, unknown> | null;
  // Where adapter-internal problems are reported (a payload that fails to
  // JSON-serialize, an add after close). Provenance must never crash the
  // agent; default console.warn.
  warn?: (message: string) => void;
}

const DEFAULT_BATCH: BatchOptions = { maxEvents: 64, flushOnIdle: 2_000, name: "langchain" };

interface RunChainState {
  seq: number;
  lastEventId: string | null;
}

export class AnchorCallbackHandler extends BaseCallbackHandler {
  name = "ario-anchor-langchain";

  // One receipt promise per anchored event, in emission order. Each resolves
  // at its window's flush with the event's inclusion proof.
  readonly receipts: Promise<InclusionReceipt>[] = [];

  readonly #batch: Batch;
  readonly #mapPayload: AnchorCallbacksOptions["mapPayload"];
  readonly #warn: (message: string) => void;
  // runId -> root runId, resolved through parents as callbacks arrive.
  readonly #rootOf = new Map<string, string>();
  // root runId -> per-run chain state (seq counter + previous event id).
  readonly #chains = new Map<string, RunChainState>();

  constructor(anchorer: Anchorer, options: AnchorCallbacksOptions = {}) {
    super();
    this.#batch = anchorer.batch(options.batch ?? DEFAULT_BATCH);
    this.#mapPayload = options.mapPayload;
    this.#warn = options.warn ?? ((m) => console.warn(`[ario-anchor-langchain] ${m}`));
  }

  // ---- lifecycle ---------------------------------------------------------

  // Flush whatever is buffered and refuse further adds; resolves with every
  // anchored event's inclusion receipt. Call this at the end of your run /
  // request / process — there are no hidden process-exit hooks.
  async close(): Promise<InclusionReceipt[]> {
    await this.#batch.close();
    return Promise.all(this.receipts);
  }

  // Force a checkpoint now without closing (long-lived handlers).
  async flush(): Promise<void> {
    await this.#batch.flush();
  }

  // ---- the seam: every callback is one synchronous batch.add() -----------

  override handleChainStart(
    _chain: unknown,
    inputs: unknown,
    runId: string,
    parentRunId?: string,
  ): void {
    this.#emit("langchain.chain_start", { inputs }, runId, parentRunId);
  }

  override handleChainEnd(outputs: unknown, runId: string, parentRunId?: string): void {
    this.#emit("langchain.chain_end", { outputs }, runId, parentRunId);
    this.#endRun(runId);
  }

  override handleChainError(err: unknown, runId: string, parentRunId?: string): void {
    this.#emit("langchain.chain_error", { error: errorMessage(err) }, runId, parentRunId);
    this.#endRun(runId);
  }

  override handleChatModelStart(
    _llm: unknown,
    messages: unknown,
    runId: string,
    parentRunId?: string,
  ): void {
    this.#emit("langchain.chat_model_start", { messages }, runId, parentRunId);
  }

  override handleLLMStart(
    _llm: unknown,
    prompts: string[],
    runId: string,
    parentRunId?: string,
  ): void {
    this.#emit("langchain.llm_start", { prompts }, runId, parentRunId);
  }

  override handleLLMEnd(output: unknown, runId: string, parentRunId?: string): void {
    this.#emit("langchain.llm_end", { output }, runId, parentRunId);
    this.#endRun(runId);
  }

  override handleLLMError(err: unknown, runId: string, parentRunId?: string): void {
    this.#emit("langchain.llm_error", { error: errorMessage(err) }, runId, parentRunId);
    this.#endRun(runId);
  }

  override handleToolStart(
    _tool: unknown,
    input: string,
    runId: string,
    parentRunId?: string,
  ): void {
    this.#emit("langchain.tool_start", { input }, runId, parentRunId);
  }

  override handleToolEnd(output: unknown, runId: string, parentRunId?: string): void {
    this.#emit("langchain.tool_end", { output }, runId, parentRunId);
    this.#endRun(runId);
  }

  override handleToolError(err: unknown, runId: string, parentRunId?: string): void {
    this.#emit("langchain.tool_error", { error: errorMessage(err) }, runId, parentRunId);
    this.#endRun(runId);
  }

  override handleRetrieverStart(
    _retriever: unknown,
    query: string,
    runId: string,
    parentRunId?: string,
  ): void {
    this.#emit("langchain.retriever_start", { query }, runId, parentRunId);
  }

  override handleRetrieverEnd(documents: unknown, runId: string, parentRunId?: string): void {
    this.#emit("langchain.retriever_end", { documents }, runId, parentRunId);
    this.#endRun(runId);
  }

  // ---- internals ----------------------------------------------------------

  #emit(
    type: LangChainEventType,
    payload: Record<string, unknown>,
    runId: string,
    parentRunId?: string,
  ): void {
    try {
      // Resolve this run's root through its parent. Roots are their own root.
      const rootRunId = parentRunId ? (this.#rootOf.get(parentRunId) ?? parentRunId) : runId;
      this.#rootOf.set(runId, rootRunId);

      // Per-root event chain: seq + previous event id, committed alongside
      // the LangChain linkage. Each record points at its predecessor, so a
      // dropped or reordered event leaves a dangling pointer an auditor can
      // see — and every pointer sits inside hash-committed, inclusion-proofed
      // bytes, so it cannot be edited after the fact.
      const chain = this.#chains.get(rootRunId) ?? { seq: 0, lastEventId: null };
      const eventId = globalThis.crypto.randomUUID();

      const event: LangChainAnchorEvent = {
        type,
        payload,
        runId,
        ...(parentRunId !== undefined ? { parentRunId } : {}),
        rootRunId,
        seq: chain.seq,
        prevEventId: chain.lastEventId,
        eventId,
      };

      let committed: Record<string, unknown> | null = event.payload;
      if (this.#mapPayload) committed = this.#mapPayload(event);
      if (committed === null) return; // caller opted this event out

      const handle = this.#batch.add({
        type,
        data: JSON.stringify(committed),
        eventId,
        metadata: {
          langchain: {
            run_id: runId,
            parent_run_id: parentRunId ?? null,
            root_run_id: rootRunId,
            seq: chain.seq,
            prev_event_id: chain.lastEventId,
          },
        },
      });

      // Only advance the chain for events that were actually committed.
      this.#chains.set(rootRunId, { seq: chain.seq + 1, lastEventId: eventId });
      this.receipts.push(handle.receipt());
    } catch (err) {
      // Provenance must never take the agent down with it.
      this.#warn(`${type} not anchored: ${errorMessage(err)}`);
    }
  }

  // A run that has ended emits nothing further; drop its root lookup. When
  // the ROOT itself ends, drop the chain state too — the next root run
  // starts a fresh chain. Bounds memory for long-lived handlers.
  #endRun(runId: string): void {
    const root = this.#rootOf.get(runId);
    this.#rootOf.delete(runId);
    if (root === runId) this.#chains.delete(runId);
  }
}

// The one-line entry point:
//
//   const provenance = anchorCallbacks(createAnchorer());
//   await chain.invoke(input, { callbacks: [provenance] });
//   const receipts = await provenance.close();
export function anchorCallbacks(
  anchorer: Anchorer,
  options?: AnchorCallbacksOptions,
): AnchorCallbackHandler {
  return new AnchorCallbackHandler(anchorer, options);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
