// Adapter tests at the anchorer boundary (PRD testing seam 6): a spy
// anchorer whose batch() records add() calls — zero cryptography, zero
// network. The adapter's jobs are asserted directly: translate each
// callback into a correctly shaped batch.add(), commit the run-tree
// linkage, honor the redaction hook, and tie close() to the batch
// lifecycle. One test drives the handler through REAL LangChain callback
// dispatch (FakeListChatModel — still no crypto, no network).

import type { Anchorer, BatchEventInput, BatchOptions, InclusionReceipt } from "@ar.io/anchor";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { describe, expect, it } from "vitest";

import { AnchorCallbackHandler, anchorCallbacks } from "../src/index";

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
  return {
    anchorer,
    adds,
    batchOptions,
    counts: () => ({ flushes, closes }),
  };
}

function meta(add: BatchEventInput) {
  return (add.metadata as { langchain: Record<string, unknown> }).langchain;
}

describe("AnchorCallbackHandler — callback → batch.add translation", () => {
  it("anchors a callback as a typed, hash-committable event with run-tree metadata", () => {
    const { anchorer, adds } = spyAnchorer();
    const handler = anchorCallbacks(anchorer);

    handler.handleChainStart({}, { question: "q" }, "run-root");

    expect(adds).toHaveLength(1);
    const add = adds[0]!;
    expect(add.type).toBe("langchain.chain_start");
    expect(JSON.parse(add.data as string)).toEqual({ inputs: { question: "q" } });
    expect(add.eventId).toMatch(UUID_RE);
    expect(meta(add)).toEqual({
      run_id: "run-root",
      parent_run_id: null,
      root_run_id: "run-root",
      seq: 0,
      prev_event_id: null,
    });
  });

  it("covers the full vocabulary, including error events", () => {
    const { anchorer, adds } = spyAnchorer();
    const handler = anchorCallbacks(anchorer);

    handler.handleChainStart({}, {}, "r1");
    handler.handleChatModelStart({}, [[]], "r2", "r1");
    handler.handleLLMStart({}, ["p"], "r3", "r1");
    handler.handleLLMEnd({ generations: [] }, "r3", "r1");
    handler.handleLLMError(new Error("rate limited"), "r2", "r1");
    handler.handleToolStart({}, "input", "r4", "r1");
    handler.handleToolEnd("output", "r4", "r1");
    handler.handleToolError(new Error("tool down"), "r5", "r1");
    handler.handleRetrieverStart({}, "query", "r6", "r1");
    handler.handleRetrieverEnd([{ pageContent: "doc" }], "r6", "r1");
    handler.handleChainError(new Error("boom"), "r1");

    expect(adds.map((a) => a.type)).toEqual([
      "langchain.chain_start",
      "langchain.chat_model_start",
      "langchain.llm_start",
      "langchain.llm_end",
      "langchain.llm_error",
      "langchain.tool_start",
      "langchain.tool_end",
      "langchain.tool_error",
      "langchain.retriever_start",
      "langchain.retriever_end",
      "langchain.chain_error",
    ]);
    expect(JSON.parse(adds[4]!.data as string)).toEqual({ error: "rate limited" });
  });
});

describe("the run tree — the committed chain", () => {
  it("links every event to its root run and to the previous event (seq + prev_event_id)", () => {
    const { anchorer, adds } = spyAnchorer();
    const handler = anchorCallbacks(anchorer);

    handler.handleChainStart({}, {}, "root");
    handler.handleChatModelStart({}, [[]], "child", "root");
    handler.handleLLMEnd({}, "child", "root");
    handler.handleChainEnd({}, "root");

    const m = adds.map(meta);
    // Everything resolves to the same root, including grandchildren-by-parent.
    expect(m.every((x) => x.root_run_id === "root")).toBe(true);
    // seq is the root run's event ordinal.
    expect(m.map((x) => x.seq)).toEqual([0, 1, 2, 3]);
    // Each event points at its predecessor's minted event_id.
    expect(m[0]!.prev_event_id).toBeNull();
    expect(m[1]!.prev_event_id).toBe(adds[0]!.eventId);
    expect(m[2]!.prev_event_id).toBe(adds[1]!.eventId);
    expect(m[3]!.prev_event_id).toBe(adds[2]!.eventId);
  });

  it("resolves roots transitively through parents", () => {
    const { anchorer, adds } = spyAnchorer();
    const handler = anchorCallbacks(anchorer);

    handler.handleChainStart({}, {}, "root");
    handler.handleChainStart({}, {}, "mid", "root");
    handler.handleToolStart({}, "x", "leaf", "mid");

    expect(adds.map(meta).map((x) => x.root_run_id)).toEqual(["root", "root", "root"]);
  });

  it("starts a fresh chain after the root run ends", () => {
    const { anchorer, adds } = spyAnchorer();
    const handler = anchorCallbacks(anchorer);

    handler.handleChainStart({}, {}, "run-a");
    handler.handleChainEnd({}, "run-a");
    handler.handleChainStart({}, {}, "run-b");

    const m = adds.map(meta);
    expect(m[2]!.seq).toBe(0);
    expect(m[2]!.prev_event_id).toBeNull();
    expect(m[2]!.root_run_id).toBe("run-b");
  });
});

describe("mapPayload — the caller controls what the hash commits to", () => {
  it("commits the transformed payload, not the original", () => {
    const { anchorer, adds } = spyAnchorer();
    const handler = anchorCallbacks(anchorer, {
      mapPayload: (e) => ({ kind: e.type, redacted: true }),
    });

    handler.handleLLMStart({}, ["the secret prompt"], "r1");

    expect(JSON.parse(adds[0]!.data as string)).toEqual({
      kind: "langchain.llm_start",
      redacted: true,
    });
    expect(adds[0]!.data as string).not.toContain("secret");
  });

  it("returning null skips the event without breaking the chain for committed ones", () => {
    const { anchorer, adds } = spyAnchorer();
    const handler = anchorCallbacks(anchorer, {
      mapPayload: (e) => (e.type === "langchain.chat_model_start" ? null : e.payload),
    });

    handler.handleChainStart({}, {}, "root");
    handler.handleChatModelStart({}, [[]], "child", "root"); // skipped
    handler.handleChainEnd({}, "root");

    expect(adds.map((a) => a.type)).toEqual(["langchain.chain_start", "langchain.chain_end"]);
    // The skipped event consumed no seq and left no dangling pointer.
    expect(adds.map(meta).map((x) => x.seq)).toEqual([0, 1]);
    expect(meta(adds[1]!).prev_event_id).toBe(adds[0]!.eventId);
  });
});

describe("lifecycle + safety", () => {
  it("close() closes the batch and resolves every receipt", async () => {
    const { anchorer, counts } = spyAnchorer();
    const handler = anchorCallbacks(anchorer);

    handler.handleChainStart({}, {}, "r");
    handler.handleChainEnd({}, "r");
    const receipts = await handler.close();

    expect(counts().closes).toBe(1);
    expect(receipts).toHaveLength(2);
    expect(handler.receipts).toHaveLength(2);
  });

  it("flush() forces a checkpoint without closing", async () => {
    const { anchorer, counts } = spyAnchorer();
    const handler = anchorCallbacks(anchorer);
    await handler.flush();
    expect(counts().flushes).toBe(1);
    expect(counts().closes).toBe(0);
  });

  it("a payload that cannot serialize warns and never throws into the agent", () => {
    const { anchorer, adds } = spyAnchorer();
    const warnings: string[] = [];
    const handler = anchorCallbacks(anchorer, { warn: (m) => warnings.push(m) });

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => handler.handleChainStart({}, circular, "r1")).not.toThrow();

    expect(adds).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("langchain.chain_start");
  });

  it("passes batch options through to the anchorer", () => {
    const { anchorer, batchOptions } = spyAnchorer();
    anchorCallbacks(anchorer, { batch: { maxEvents: 7, name: "custom" } });
    expect(batchOptions[0]).toEqual({ maxEvents: 7, name: "custom" });
  });
});

describe("real LangChain dispatch (FakeListChatModel — no crypto, no network)", () => {
  it("a model invocation flows through LangChain's callback machinery into the batcher", async () => {
    const { anchorer, adds } = spyAnchorer();
    const handler = new AnchorCallbackHandler(anchorer);

    const model = new FakeListChatModel({ responses: ["anchored"] });
    await model.invoke("What is provenance?", { callbacks: [handler] });

    const types = adds.map((a) => a.type);
    expect(types).toContain("langchain.chat_model_start");
    expect(types).toContain("langchain.llm_end");
    // Real dispatch supplies real UUIDs; the run tree is committed.
    for (const add of adds) {
      expect(meta(add).run_id).toMatch(UUID_RE);
      expect(meta(add).root_run_id).toMatch(UUID_RE);
    }
  });
});
