// @ar.io/anchor-vercel — anchor your AI SDK calls as they run. One language-
// model middleware turns every generate / stream into a provenance event on
// @ar.io/anchor's Merkle batcher: N calls per window become ONE Arweave
// write, and every call keeps its own standalone, offline-verifiable
// inclusion proof.
//
// HOW THIS DIFFERS FROM @ar.io/anchor-langchain. LangChain's callback seam
// hands us a run tree (runId/parentRunId), so that adapter commits a
// parent/child tree. The Vercel AI SDK middleware seam wraps the MODEL, not
// the application — there is no run tree to inherit. So events here form a
// FLAT chain (seq + prev_event_id, same committed-metadata mechanism), keyed
// by one of two grouping strategies (design decision, docs/design-vercel-
// adapter-chaining.md):
//   1. a caller-supplied correlation id, read from
//      params.providerOptions.ario.chainKey — group by request/conversation;
//   2. otherwise, a per-middleware-instance session chain — every call
//      through this middleware, in emission order.
// Either way it is a flat sequence, not a tree; the README says so plainly.
//
// Disclosure (ario.events/v1, Minimal): prompts, settings, and outputs go
// into the committed record, which is hashed locally and handed back to YOU
// via the receipt — the on-chain envelope carries only the hash. Nothing
// semantic ever leaves your process; `mapPayload` trims/redacts what the
// hash commits to before it is computed.

import type { Anchorer, Batch, BatchOptions, InclusionReceipt } from "@ar.io/anchor";
import type { LanguageModelMiddleware } from "ai";

// providerOptions namespace + key the adapter reads a correlation id from:
//   generateText({ model, providerOptions: { ario: { chainKey: "req-42" } } })
export const PROVIDER_OPTIONS_NAMESPACE = "ario";
export const CHAIN_KEY_OPTION = "chainKey";

// The adapter's event_type vocabulary (profile §4: adapter-namespaced,
// additive-minor). One type per anchored middleware operation.
export const EVENT_TYPES = [
  "vercel_ai.generate_start",
  "vercel_ai.generate_end",
  "vercel_ai.generate_error",
  "vercel_ai.stream_start",
  "vercel_ai.stream_end",
  "vercel_ai.stream_error",
] as const;

export type VercelEventType = (typeof EVENT_TYPES)[number];

// The model's stream-part type, derived from the middleware contract we
// already import — so the stream tap is type-safe (discriminated on `type`)
// without taking a direct dependency on @ai-sdk/provider.
type StreamResult = Awaited<ReturnType<NonNullable<LanguageModelMiddleware["wrapStream"]>>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer P> ? P : never;

// What `mapPayload` sees for every event, before anything is committed.
export interface VercelAnchorEvent {
  type: VercelEventType;
  // The semantic content (prompt/settings/result). Whatever this is after
  // mapPayload runs is JSON-serialized and hash-committed.
  payload: Record<string, unknown>;
  // The resolved chain this event belongs to: a caller correlation id, or
  // the per-instance session id when none was supplied.
  chainKey: string;
  // True when chainKey came from the caller (providerOptions.ario.chainKey),
  // false when it fell back to the session chain.
  callerSupplied: boolean;
  seq: number;
  prevEventId: string | null;
  eventId: string;
}

export interface AnchorMiddlewareOptions {
  // Passed to anchorer.batch(). Default: { maxEvents: 64, flushOnIdle: 2000,
  // name: "vercel-ai" }.
  batch?: BatchOptions;
  // Trim/redact/transform the payload before it is hash-committed. Return
  // null to skip anchoring the event entirely (consumes no sequence number,
  // so the committed chain stays gapless). The chain linkage is unaffected.
  mapPayload?: (event: VercelAnchorEvent) => Record<string, unknown> | null;
  // Where adapter-internal problems are reported (a payload that fails to
  // JSON-serialize, an add after close). Provenance must never crash the
  // model call; default console.warn.
  warn?: (message: string) => void;
  // Upper bound on distinct chain keys tracked at once (LRU). A long-lived
  // middleware that sees a new correlation id per request would otherwise
  // grow its chain-state map without bound (unlike the langchain adapter,
  // whose run tree has an observable end). Default 10_000 — sized so
  // request-scoped ids never evict an active chain in practice; an id
  // evicted after long inactivity simply restarts at seq 0 if it returns.
  maxTrackedChains?: number;
}

const DEFAULT_BATCH: BatchOptions = { maxEvents: 64, flushOnIdle: 2_000, name: "vercel-ai" };
const DEFAULT_MAX_TRACKED_CHAINS = 10_000;

interface ChainState {
  seq: number;
  lastEventId: string | null;
}

// A LanguageModelMiddleware with provenance lifecycle attached. Pass it
// straight to wrapLanguageModel({ model, middleware }); call close() at the
// end of the request/run to flush and collect receipts.
export class AnchorMiddleware implements LanguageModelMiddleware {
  // Discriminant required by the v3 middleware contract.
  readonly specificationVersion = "v3" as const;

  // One receipt promise per anchored event, in emission order.
  readonly receipts: Promise<InclusionReceipt>[] = [];

  readonly #batch: Batch;
  readonly #mapPayload: AnchorMiddlewareOptions["mapPayload"];
  readonly #warn: (message: string) => void;
  readonly #maxTrackedChains: number;
  // Per-chain-key flat sequence state. Bounded LRU (see #maxTrackedChains):
  // Map insertion order is the recency order; #emit re-inserts on each event.
  readonly #chains = new Map<string, ChainState>();
  // The fallback chain id for calls with no caller correlation id.
  readonly #sessionId = globalThis.crypto.randomUUID();

  constructor(anchorer: Anchorer, options: AnchorMiddlewareOptions = {}) {
    this.#batch = anchorer.batch(options.batch ?? DEFAULT_BATCH);
    this.#mapPayload = options.mapPayload;
    this.#warn = options.warn ?? ((m) => console.warn(`[ario-anchor-vercel] ${m}`));
    this.#maxTrackedChains = options.maxTrackedChains ?? DEFAULT_MAX_TRACKED_CHAINS;
  }

  // ---- lifecycle ---------------------------------------------------------

  // Flush whatever is buffered and refuse further adds; resolves with every
  // anchored event's inclusion receipt. Call at the end of your request /
  // run / process — there are no hidden process-exit hooks.
  async close(): Promise<InclusionReceipt[]> {
    await this.#batch.close();
    return Promise.all(this.receipts);
  }

  // Force a checkpoint now without closing (long-lived middleware).
  async flush(): Promise<void> {
    await this.#batch.flush();
  }

  // ---- the seam: wrapGenerate / wrapStream -------------------------------

  wrapGenerate: NonNullable<LanguageModelMiddleware["wrapGenerate"]> = async ({
    doGenerate,
    params,
  }) => {
    const chainKeyInfo = this.#resolveChainKey(params);
    this.#emit("vercel_ai.generate_start", { prompt: params.prompt }, chainKeyInfo);
    try {
      const result = await doGenerate();
      this.#emit(
        "vercel_ai.generate_end",
        { content: result.content, usage: result.usage, finishReason: result.finishReason },
        chainKeyInfo,
      );
      return result;
    } catch (err) {
      this.#emit("vercel_ai.generate_error", { error: errorMessage(err) }, chainKeyInfo);
      throw err; // provenance observes; it never swallows the model's error
    }
  };

  wrapStream: NonNullable<LanguageModelMiddleware["wrapStream"]> = async ({
    doStream,
    params,
  }) => {
    const chainKeyInfo = this.#resolveChainKey(params);
    this.#emit("vercel_ai.stream_start", { prompt: params.prompt }, chainKeyInfo);

    let result: Awaited<ReturnType<typeof doStream>>;
    try {
      result = await doStream();
    } catch (err) {
      this.#emit("vercel_ai.stream_error", { error: errorMessage(err) }, chainKeyInfo);
      throw err;
    }

    // Anchor stream completion at flush — the stream's natural batch
    // boundary. Chunks pass through untouched. A provider failure arrives in
    // v3 as an in-band `error` part (not a stream rejection), so we capture
    // it here and emit a terminal stream_error instead of stream_end —
    // symmetric with the generate path. A hard transport abort (the stream
    // rejects with no error part) fires neither: stream_start stands and its
    // absence-of-completion is the signal (the dangling chain pointer).
    let parts = 0;
    let finishReason: unknown;
    let streamError: unknown;
    const tap = new TransformStream<StreamPart, StreamPart>({
      transform: (chunk, controller) => {
        parts++;
        if (chunk.type === "finish") finishReason = chunk.finishReason;
        else if (chunk.type === "error") streamError = chunk.error;
        controller.enqueue(chunk);
      },
      flush: () => {
        if (streamError !== undefined) {
          this.#emit("vercel_ai.stream_error", { error: streamError, parts }, chainKeyInfo);
        } else {
          this.#emit("vercel_ai.stream_end", { parts, finishReason }, chainKeyInfo);
        }
      },
    });

    return { ...result, stream: result.stream.pipeThrough(tap) };
  };

  // ---- internals ----------------------------------------------------------

  #resolveChainKey(params: { providerOptions?: Record<string, unknown> }): {
    chainKey: string;
    callerSupplied: boolean;
  } {
    const ns = params.providerOptions?.[PROVIDER_OPTIONS_NAMESPACE] as
      | Record<string, unknown>
      | undefined;
    const supplied = ns?.[CHAIN_KEY_OPTION];
    if (typeof supplied === "string" && supplied.length > 0) {
      return { chainKey: supplied, callerSupplied: true };
    }
    return { chainKey: `session:${this.#sessionId}`, callerSupplied: false };
  }

  #emit(
    type: VercelEventType,
    payload: Record<string, unknown>,
    chainKeyInfo: { chainKey: string; callerSupplied: boolean },
  ): void {
    try {
      const { chainKey, callerSupplied } = chainKeyInfo;
      const chain = this.#chains.get(chainKey) ?? { seq: 0, lastEventId: null };
      const eventId = globalThis.crypto.randomUUID();

      const event: VercelAnchorEvent = {
        type,
        payload,
        chainKey,
        callerSupplied,
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
          vercel_ai: {
            chain_key: chainKey,
            caller_supplied_chain: callerSupplied,
            seq: chain.seq,
            prev_event_id: chain.lastEventId,
          },
        },
      });

      // Advance the chain only for events that were actually committed.
      // delete+set moves this key to the most-recently-used position (Map
      // preserves insertion order), then evict the least-recently-used key
      // if we're over the bound — keeps long-lived middleware from leaking
      // one entry per distinct correlation id forever.
      this.#chains.delete(chainKey);
      this.#chains.set(chainKey, { seq: chain.seq + 1, lastEventId: eventId });
      if (this.#chains.size > this.#maxTrackedChains) {
        const lru = this.#chains.keys().next().value;
        if (lru !== undefined) this.#chains.delete(lru);
      }
      this.receipts.push(handle.receipt());
    } catch (err) {
      // Provenance must never take the model call down with it.
      this.#warn(`${type} not anchored: ${errorMessage(err)}`);
    }
  }
}

// The one-import entry point:
//
//   const provenance = anchorMiddleware(createAnchorer());
//   const model = wrapLanguageModel({ model: baseModel, middleware: provenance });
//   await generateText({ model, prompt: "…" });
//   const receipts = await provenance.close();
export function anchorMiddleware(
  anchorer: Anchorer,
  options?: AnchorMiddlewareOptions,
): AnchorMiddleware {
  return new AnchorMiddleware(anchorer, options);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
