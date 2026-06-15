// Adapter tests at the anchorer boundary (PRD testing seam 6): a spy
// anchorer whose batch() records add() calls — zero cryptography, zero
// network. The adapter's jobs are asserted directly: translate each
// middleware operation into a correctly shaped batch.add(), resolve the
// chain key (caller correlation id vs. session fallback), commit the flat
// linkage, honor the redaction hook, and tie close() to the batch
// lifecycle. The final block drives the middleware through REAL Vercel AI
// SDK dispatch (MockLanguageModelV3 — still no crypto, no network).

import type { Anchorer, BatchEventInput, BatchOptions, InclusionReceipt } from "@ar.io/anchor";
import { generateText, streamText, wrapLanguageModel } from "ai";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import { describe, expect, it } from "vitest";

import { AnchorMiddleware, anchorMiddleware } from "../src/index";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function spyAnchorer() {
  const adds: BatchEventInput[] = [];
  const batchOptions: BatchOptions[] = [];
  let flushes = 0;
  let closes = 0;
  const receipt = { txId: "TX_SPY", leafIndex: 0 } as unknown as InclusionReceipt;
  const anchorer = {
    environment: "dev",
    batch(options: BatchOptions) {
      batchOptions.push(options);
      return {
        add(event: BatchEventInput) {
          adds.push(event);
          return { receipt: async () => receipt };
        },
        flush: async () => {
          flushes++;
        },
        close: async () => {
          closes++;
        },
        get size() {
          return 0;
        },
      };
    },
    anchor: () => {
      throw new Error("unused — adapter must use the batcher, never single-shot");
    },
  } as unknown as Anchorer;
  return { anchorer, adds, batchOptions, counts: () => ({ flushes, closes }) };
}

function meta(add: BatchEventInput) {
  return (add.metadata as { vercel_ai: Record<string, unknown> }).vercel_ai;
}

// Minimal call-params the adapter reads: prompt + providerOptions.
function params(prompt: unknown, providerOptions?: Record<string, unknown>) {
  return { prompt, ...(providerOptions ? { providerOptions } : {}) } as never;
}

describe("AnchorMiddleware — generate", () => {
  it("anchors start + end as typed, hash-committable events", async () => {
    const { anchorer, adds } = spyAnchorer();
    const mw = anchorMiddleware(anchorer);

    await mw.wrapGenerate({
      doGenerate: async () => ({ content: [{ type: "text", text: "hi" }], usage: { totalTokens: 3 }, finishReason: "stop" }),
      params: params("the prompt"),
    } as never);

    expect(adds.map((a) => a.type)).toEqual(["vercel_ai.generate_start", "vercel_ai.generate_end"]);
    expect(JSON.parse(adds[0]!.data as string)).toEqual({ prompt: "the prompt" });
    const end = JSON.parse(adds[1]!.data as string);
    expect(end.finishReason).toBe("stop");
    expect(adds[0]!.eventId).toMatch(UUID_RE);
  });

  it("anchors an error event and re-throws (never swallows the model error)", async () => {
    const { anchorer, adds } = spyAnchorer();
    const mw = anchorMiddleware(anchorer);

    await expect(
      mw.wrapGenerate({
        doGenerate: async () => {
          throw new Error("model exploded");
        },
        params: params("p"),
      } as never),
    ).rejects.toThrow("model exploded");

    expect(adds.map((a) => a.type)).toEqual(["vercel_ai.generate_start", "vercel_ai.generate_error"]);
    expect(JSON.parse(adds[1]!.data as string)).toEqual({ error: "model exploded" });
  });
});

describe("AnchorMiddleware — stream", () => {
  it("anchors start, then end at stream flush, passing chunks through untouched", async () => {
    const { anchorer, adds } = spyAnchorer();
    const mw = anchorMiddleware(anchorer);

    const upstream = convertArrayToReadableStream([
      { type: "text-delta", id: "1", delta: "a" },
      { type: "text-delta", id: "1", delta: "b" },
      { type: "finish", finishReason: "stop", usage: { totalTokens: 2 } },
    ]);
    const { stream } = await mw.wrapStream({
      doStream: async () => ({ stream: upstream }),
      params: params("stream me"),
    } as never);

    // start anchored before the stream is consumed; end not yet.
    expect(adds.map((a) => a.type)).toEqual(["vercel_ai.stream_start"]);

    const seen: unknown[] = [];
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      seen.push(value);
    }

    expect(seen).toHaveLength(3); // every chunk passed through
    expect(adds.map((a) => a.type)).toEqual(["vercel_ai.stream_start", "vercel_ai.stream_end"]);
    const end = JSON.parse(adds[1]!.data as string);
    expect(end.parts).toBe(3);
    expect(end.finishReason).toBe("stop");
  });

  it("captures an in-band error part as a terminal stream_error (not stream_end)", async () => {
    const { anchorer, adds } = spyAnchorer();
    const mw = anchorMiddleware(anchorer);

    const upstream = convertArrayToReadableStream([
      { type: "text-delta", id: "1", delta: "partial" },
      { type: "error", error: { message: "provider blew up" } },
    ]);
    const { stream } = await mw.wrapStream({
      doStream: async () => ({ stream: upstream }),
      params: params("p"),
    } as never);

    const reader = stream.getReader();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }

    // Terminal event is stream_error, carrying the in-band error; no stream_end.
    expect(adds.map((a) => a.type)).toEqual(["vercel_ai.stream_start", "vercel_ai.stream_error"]);
    const errEvent = JSON.parse(adds[1]!.data as string);
    expect(errEvent.error).toEqual({ message: "provider blew up" });
    expect(errEvent.parts).toBe(2);
  });

  it("anchors stream_error when the doStream() call itself rejects", async () => {
    const { anchorer, adds } = spyAnchorer();
    const mw = anchorMiddleware(anchorer);

    await expect(
      mw.wrapStream({
        doStream: async () => {
          throw new Error("stream setup failed");
        },
        params: params("p"),
      } as never),
    ).rejects.toThrow("stream setup failed");

    expect(adds.map((a) => a.type)).toEqual(["vercel_ai.stream_start", "vercel_ai.stream_error"]);
    expect(JSON.parse(adds[1]!.data as string).error).toBe("stream setup failed");
  });
});

describe("chain key resolution — correlation id vs. session fallback", () => {
  it("groups by a caller-supplied providerOptions.ario.chainKey", async () => {
    const { anchorer, adds } = spyAnchorer();
    const mw = anchorMiddleware(anchorer);
    const gen = (id?: string) =>
      mw.wrapGenerate({
        doGenerate: async () => ({ content: [], usage: {}, finishReason: "stop" }),
        params: params("p", id ? { ario: { chainKey: id } } : undefined),
      } as never);

    await gen("req-42");
    await gen("req-42");

    const m = adds.map(meta);
    expect(m.every((x) => x.chain_key === "req-42")).toBe(true);
    expect(m.every((x) => x.caller_supplied_chain === true)).toBe(true);
    // Flat chain across the two calls: seq 0..3, each pointing at its predecessor.
    expect(m.map((x) => x.seq)).toEqual([0, 1, 2, 3]);
    expect(m[0]!.prev_event_id).toBeNull();
    expect(m[1]!.prev_event_id).toBe(adds[0]!.eventId);
    expect(m[3]!.prev_event_id).toBe(adds[2]!.eventId);
  });

  it("falls back to a per-instance session chain when no id is supplied", async () => {
    const { anchorer, adds } = spyAnchorer();
    const mw = anchorMiddleware(anchorer);

    await mw.wrapGenerate({
      doGenerate: async () => ({ content: [], usage: {}, finishReason: "stop" }),
      params: params("p"),
    } as never);

    const m = meta(adds[0]!);
    expect(m.caller_supplied_chain).toBe(false);
    expect(m.chain_key).toMatch(/^session:/);
  });

  it("keeps two different correlation ids on separate chains", async () => {
    const { anchorer, adds } = spyAnchorer();
    const mw = anchorMiddleware(anchorer);
    const gen = (id: string) =>
      mw.wrapGenerate({
        doGenerate: async () => ({ content: [], usage: {}, finishReason: "stop" }),
        params: params("p", { ario: { chainKey: id } }),
      } as never);

    await gen("conversation-A"); // seq 0,1
    await gen("conversation-B"); // seq 0,1 independently

    const a = adds.map(meta).filter((x) => x.chain_key === "conversation-A");
    const b = adds.map(meta).filter((x) => x.chain_key === "conversation-B");
    expect(a.map((x) => x.seq)).toEqual([0, 1]);
    expect(b.map((x) => x.seq)).toEqual([0, 1]);
    expect(b[0]!.prev_event_id).toBeNull(); // B's chain starts fresh
  });
});

describe("mapPayload — the caller controls what the hash commits to", () => {
  it("commits the transformed payload, not the original", async () => {
    const { anchorer, adds } = spyAnchorer();
    const mw = anchorMiddleware(anchorer, { mapPayload: (e) => ({ kind: e.type }) });

    await mw.wrapGenerate({
      doGenerate: async () => ({ content: [], usage: {}, finishReason: "stop" }),
      params: params("the secret prompt"),
    } as never);

    expect(adds[0]!.data as string).not.toContain("secret");
    expect(JSON.parse(adds[0]!.data as string)).toEqual({ kind: "vercel_ai.generate_start" });
  });

  it("returning null skips the event without breaking the committed chain", async () => {
    const { anchorer, adds } = spyAnchorer();
    const mw = anchorMiddleware(anchorer, {
      mapPayload: (e) => (e.type === "vercel_ai.generate_start" ? null : e.payload),
    });

    await mw.wrapGenerate({
      doGenerate: async () => ({ content: [], usage: {}, finishReason: "stop" }),
      params: params("p", { ario: { chainKey: "c" } }),
    } as never);

    expect(adds.map((a) => a.type)).toEqual(["vercel_ai.generate_end"]);
    // The skipped start consumed no seq; end is the chain's first link.
    expect(meta(adds[0]!).seq).toBe(0);
    expect(meta(adds[0]!).prev_event_id).toBeNull();
  });
});

describe("lifecycle + safety", () => {
  it("close() closes the batch and resolves every receipt", async () => {
    const { anchorer, counts } = spyAnchorer();
    const mw = anchorMiddleware(anchorer);
    await mw.wrapGenerate({
      doGenerate: async () => ({ content: [], usage: {}, finishReason: "stop" }),
      params: params("p"),
    } as never);
    const receipts = await mw.close();
    expect(counts().closes).toBe(1);
    expect(receipts).toHaveLength(2);
  });

  it("flush() forces a checkpoint without closing", async () => {
    const { anchorer, counts } = spyAnchorer();
    const mw = anchorMiddleware(anchorer);
    await mw.flush();
    expect(counts().flushes).toBe(1);
    expect(counts().closes).toBe(0);
  });

  it("a payload that cannot serialize warns and never throws into the call", async () => {
    const { anchorer } = spyAnchorer();
    const warnings: string[] = [];
    const mw = anchorMiddleware(anchorer, { warn: (m) => warnings.push(m) });

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    // generate_start serialization fails, but doGenerate must still run and return.
    const result = await mw.wrapGenerate({
      doGenerate: async () => ({ content: [{ type: "text", text: "ok" }], usage: {}, finishReason: "stop" }),
      params: params(circular),
    } as never);

    expect((result as { content: unknown[] }).content).toHaveLength(1);
    expect(warnings.some((w) => w.includes("vercel_ai.generate_start"))).toBe(true);
  });

  it("passes batch options through to the anchorer", () => {
    const { anchorer, batchOptions } = spyAnchorer();
    anchorMiddleware(anchorer, { batch: { maxEvents: 7, name: "custom" } });
    expect(batchOptions[0]).toEqual({ maxEvents: 7, name: "custom" });
  });

  it("bounds chain-state memory: evicts the least-recently-used chain past the cap", async () => {
    const { anchorer, adds } = spyAnchorer();
    // Tiny cap so the eviction is observable. Each generate emits 2 events
    // (start+end) on its correlation id's chain.
    const mw = anchorMiddleware(anchorer, { maxTrackedChains: 2 });
    const gen = (id: string) =>
      mw.wrapGenerate({
        doGenerate: async () => ({ content: [], usage: {}, finishReason: "stop" }),
        params: params("p", { ario: { chainKey: id } }),
      } as never);

    await gen("a"); // chains: {a}
    await gen("b"); // chains: {a,b}
    await gen("c"); // a evicted (LRU) → chains: {b,c}
    await gen("a"); // a was evicted, so it restarts at seq 0

    const aEvents = adds.map(meta).filter((x) => x.chain_key === "a");
    // First "a" run: seq 0,1. After eviction, the second "a" run restarts at 0.
    expect(aEvents.map((x) => x.seq)).toEqual([0, 1, 0, 1]);
    // "b" was bumped by its own use and never evicted → continuous.
    const bEvents = adds.map(meta).filter((x) => x.chain_key === "b");
    expect(bEvents.map((x) => x.seq)).toEqual([0, 1]);
  });
});

describe("real Vercel AI SDK dispatch (MockLanguageModelV3 — no crypto, no network)", () => {
  it("generateText flows through the middleware into the batcher", async () => {
    const { anchorer, adds } = spyAnchorer();
    const mw = new AnchorMiddleware(anchorer);

    const model = wrapLanguageModel({
      model: new MockLanguageModelV3({
        doGenerate: async () => ({
          finishReason: "stop",
          usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
          content: [{ type: "text", text: "anchored" }],
          warnings: [],
        }) as never,
      }),
      middleware: mw,
    });

    await generateText({ model, prompt: "What is provenance?" });

    expect(adds.map((a) => a.type)).toEqual(["vercel_ai.generate_start", "vercel_ai.generate_end"]);
  });

  it("streamText flows through, anchoring stream_end at completion", async () => {
    const { anchorer, adds } = spyAnchorer();
    const mw = new AnchorMiddleware(anchorer);

    const model = wrapLanguageModel({
      model: new MockLanguageModelV3({
        doStream: async () => ({
          stream: convertArrayToReadableStream([
            { type: "text-start", id: "1" },
            { type: "text-delta", id: "1", delta: "anchored" },
            { type: "text-end", id: "1" },
            { type: "finish", finishReason: "stop", usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 } },
          ]),
        }) as never,
      }),
      middleware: mw,
    });

    const { textStream } = streamText({ model, prompt: "stream it" });
    for await (const _ of textStream) {
      /* consume */
    }

    expect(adds.map((a) => a.type)).toEqual(["vercel_ai.stream_start", "vercel_ai.stream_end"]);
  });
});
