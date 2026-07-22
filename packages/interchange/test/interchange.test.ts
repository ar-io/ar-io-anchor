// Adapter tests at the anchorer boundary (PRD testing seam 6): a spy
// anchorer whose batch() records add() calls per session, and a fake inner
// AuditStore — zero cryptography, zero network. The adapter's jobs are
// asserted directly: delegate to the inner store FIRST (git stays the
// system of record), translate each audit/error record into a correctly
// shaped batch.add() on that session's batch, commit the per-session chain
// linkage, honor the redaction hook, and tie flushSession/close to the
// batch lifecycle.

import type { Anchorer, BatchEventInput, BatchOptions, InclusionReceipt } from "@ar.io/anchor";
import type { AuditRecord, ErrorRecord } from "@intx/types/audit";
import type { AuditStore } from "@intx/types/runtime";
import { describe, expect, it } from "vitest";

import { anchoredAuditStore, anchorRecordsFromCollector, EVENT_TYPES } from "../src/index";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function auditRecord(over: Partial<AuditRecord> = {}): AuditRecord {
  return {
    callId: "call-1",
    tool: "fs_read",
    arguments: { path: "/etc/hosts" },
    authz: { effect: "allow", resolvedBy: null, matchingGrants: [], blocked: false },
    result: { content: "127.0.0.1 localhost", isError: false },
    timestamp: "2026-07-08T00:00:00Z",
    sessionId: "sess-a",
    seq: 0,
    ...over,
  };
}

function blockedRecord(over: Partial<AuditRecord> = {}): AuditRecord {
  return auditRecord({
    callId: "call-blocked",
    tool: "shell_exec",
    authz: {
      effect: "deny",
      resolvedBy: null,
      matchingGrants: [],
      blocked: true,
      blockReason: "denied by policy",
    },
    result: { content: "", isError: true },
    ...over,
  });
}

function errorRecord(over: Partial<ErrorRecord> = {}): ErrorRecord {
  return {
    source: "inference",
    category: "rate_limit",
    message: "429 from provider",
    fatal: false,
    timestamp: "2026-07-08T00:00:01Z",
    sessionId: "sess-a",
    seq: 1,
    ...over,
  };
}

function fakeInner() {
  const calls: { method: string; count: number }[] = [];
  const loaded = [auditRecord()];
  const inner: AuditStore = {
    commitAudit: async (records) => {
      calls.push({ method: "commitAudit", count: records.length });
    },
    loadAudit: async (sessionId) => {
      calls.push({ method: `loadAudit:${sessionId}`, count: 0 });
      return loaded;
    },
    commitErrors: async (records) => {
      calls.push({ method: "commitErrors", count: records.length });
    },
  };
  return { inner, calls, loaded };
}

function spyAnchorer() {
  const adds: BatchEventInput[] = [];
  const batchOptions: BatchOptions[] = [];
  const batches: { adds: BatchEventInput[]; flushes: number; closes: number }[] = [];
  const anchorer = {
    environment: "dev",
    batch(options: BatchOptions) {
      batchOptions.push(options);
      const state = { adds: [] as BatchEventInput[], flushes: 0, closes: 0 };
      batches.push(state);
      return {
        add(event: BatchEventInput) {
          adds.push(event);
          state.adds.push(event);
          return {
            receipt: async () => ({ txId: "TX_SPY", eventId: event.eventId }) as unknown as InclusionReceipt,
          };
        },
        flush: async () => {
          state.flushes++;
        },
        close: async () => {
          state.closes++;
        },
        get size() {
          return state.adds.length;
        },
      };
    },
    anchor: () => {
      throw new Error("unused — adapter must use the batcher, never single-shot");
    },
  } as unknown as Anchorer;
  return { anchorer, adds, batchOptions, batches };
}

function meta(add: BatchEventInput) {
  return (add.metadata as { interchange: Record<string, unknown> }).interchange;
}

describe("event vocabulary", () => {
  it("exports the three adapter-namespaced event types", () => {
    expect(EVENT_TYPES).toEqual([
      "interchange.tool_call",
      "interchange.tool_blocked",
      "interchange.error",
    ]);
  });
});

describe("anchoredAuditStore — record → batch.add translation", () => {
  it("anchors an allowed call as interchange.tool_call with the session metadata block", async () => {
    const { anchorer, adds } = spyAnchorer();
    const { inner } = fakeInner();
    const store = anchoredAuditStore(inner, anchorer);

    await store.commitAudit([auditRecord()]);

    expect(adds).toHaveLength(1);
    const add = adds[0]!;
    expect(add.type).toBe("interchange.tool_call");
    expect(JSON.parse(add.data as string)).toEqual(auditRecord());
    expect(add.eventId).toMatch(UUID_RE);
    expect(meta(add)).toEqual({
      session_id: "sess-a",
      call_id: "call-1",
      seq: 0,
      tool: "fs_read",
      blocked: false,
      prev_event_id: null,
    });
  });

  it("anchors a blocked call as interchange.tool_blocked", async () => {
    const { anchorer, adds } = spyAnchorer();
    const { inner } = fakeInner();
    const store = anchoredAuditStore(inner, anchorer);

    await store.commitAudit([blockedRecord({ seq: 3 })]);

    expect(adds[0]!.type).toBe("interchange.tool_blocked");
    expect(meta(adds[0]!)).toMatchObject({
      call_id: "call-blocked",
      tool: "shell_exec",
      blocked: true,
      seq: 3,
    });
  });

  it("a null authz (no grant matched, call ran) is an allowed call", async () => {
    const { anchorer, adds } = spyAnchorer();
    const { inner } = fakeInner();
    const store = anchoredAuditStore(inner, anchorer);

    await store.commitAudit([auditRecord({ authz: null })]);

    expect(adds[0]!.type).toBe("interchange.tool_call");
    expect(meta(adds[0]!).blocked).toBe(false);
  });

  it("anchors an error record as interchange.error in the same session chain", async () => {
    const { anchorer, adds } = spyAnchorer();
    const { inner } = fakeInner();
    const store = anchoredAuditStore(inner, anchorer);

    await store.commitAudit([auditRecord()]);
    await store.commitErrors([errorRecord()]);

    expect(adds).toHaveLength(2);
    const err = adds[1]!;
    expect(err.type).toBe("interchange.error");
    expect(JSON.parse(err.data as string)).toEqual(errorRecord());
    expect(meta(err)).toEqual({
      session_id: "sess-a",
      call_id: null,
      seq: 1,
      tool: null,
      blocked: false,
      prev_event_id: adds[0]!.eventId,
    });
  });
});

describe("delegation — the inner store stays the system of record", () => {
  it("delegates to inner.commitAudit before anchoring anything", async () => {
    const order: string[] = [];
    const { anchorer, adds } = spyAnchorer();
    const inner: AuditStore = {
      commitAudit: async () => {
        order.push(`inner(adds so far: ${adds.length})`);
      },
      loadAudit: async () => [],
      commitErrors: async () => {},
    };
    const store = anchoredAuditStore(inner, anchorer);

    await store.commitAudit([auditRecord()]);

    // Inner ran first, with nothing anchored yet.
    expect(order).toEqual(["inner(adds so far: 0)"]);
    expect(adds).toHaveLength(1);
  });

  it("anchors nothing when the inner store throws", async () => {
    const { anchorer, adds } = spyAnchorer();
    const inner: AuditStore = {
      commitAudit: async () => {
        throw new Error("git is locked");
      },
      loadAudit: async () => [],
      commitErrors: async () => {
        throw new Error("git is locked");
      },
    };
    const store = anchoredAuditStore(inner, anchorer);

    await expect(store.commitAudit([auditRecord()])).rejects.toThrow(/git is locked/);
    await expect(store.commitErrors([errorRecord()])).rejects.toThrow(/git is locked/);
    expect(adds).toHaveLength(0);
  });

  it("passes the AbortSignal through and delegates loadAudit untouched", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const { anchorer } = spyAnchorer();
    const { inner, calls, loaded } = fakeInner();
    const spyInner: AuditStore = {
      ...inner,
      commitAudit: async (records, signal) => {
        signals.push(signal);
        return inner.commitAudit(records, signal);
      },
    };
    const store = anchoredAuditStore(spyInner, anchorer);

    const controller = new AbortController();
    await store.commitAudit([auditRecord()], controller.signal);
    expect(signals).toEqual([controller.signal]);

    const records = await store.loadAudit("sess-a");
    expect(records).toBe(loaded);
    expect(calls.some((c) => c.method === "loadAudit:sess-a")).toBe(true);
  });
});

describe("per-session batching and chaining", () => {
  it("creates one batch per session, lazily, with a session-scoped chain name", async () => {
    const { anchorer, batchOptions } = spyAnchorer();
    const { inner } = fakeInner();
    const store = anchoredAuditStore(inner, anchorer);

    await store.commitAudit([
      auditRecord({ sessionId: "sess-a", callId: "a0", seq: 0 }),
      auditRecord({ sessionId: "sess-b", callId: "b0", seq: 0 }),
      auditRecord({ sessionId: "sess-a", callId: "a1", seq: 1 }),
    ]);

    expect(batchOptions).toHaveLength(2);
    expect(batchOptions.map((o) => o.name)).toEqual(["interchange:sess-a", "interchange:sess-b"]);
  });

  it("chains prev_event_id per session, across audits and errors", async () => {
    const { anchorer, adds } = spyAnchorer();
    const { inner } = fakeInner();
    const store = anchoredAuditStore(inner, anchorer);

    await store.commitAudit([
      auditRecord({ sessionId: "sess-a", callId: "a0", seq: 0 }),
      auditRecord({ sessionId: "sess-b", callId: "b0", seq: 0 }),
      auditRecord({ sessionId: "sess-a", callId: "a1", seq: 1 }),
    ]);
    await store.commitErrors([errorRecord({ sessionId: "sess-b", seq: 1 })]);

    const m = adds.map(meta);
    // sess-a: a0 → a1; sess-b: b0 → error. The two chains never cross.
    expect(m[0]!.prev_event_id).toBeNull();
    expect(m[1]!.prev_event_id).toBeNull();
    expect(m[2]!.prev_event_id).toBe(adds[0]!.eventId);
    expect(m[3]!.prev_event_id).toBe(adds[1]!.eventId);
  });

  it("passes batch options through, keeping the per-session name suffix", async () => {
    const { anchorer, batchOptions } = spyAnchorer();
    const { inner } = fakeInner();
    const store = anchoredAuditStore(inner, anchorer, {
      batch: { maxEvents: 7, flushOnIdle: 500, name: "custom" },
    });

    await store.commitAudit([auditRecord()]);

    expect(batchOptions[0]).toEqual({ maxEvents: 7, flushOnIdle: 500, name: "custom:sess-a" });
  });
});

describe("mapPayload — the caller controls what the hash commits to", () => {
  it("commits the transformed payload, not the original", async () => {
    const { anchorer, adds } = spyAnchorer();
    const { inner } = fakeInner();
    const store = anchoredAuditStore(inner, anchorer, {
      mapPayload: (e) => ({ tool: e.payload.tool, redacted: true }),
    });

    await store.commitAudit([auditRecord({ arguments: { secret: "hunter2" } })]);

    expect(JSON.parse(adds[0]!.data as string)).toEqual({ tool: "fs_read", redacted: true });
    expect(adds[0]!.data as string).not.toContain("hunter2");
  });

  it("returning null skips the record without breaking the chain", async () => {
    const { anchorer, adds } = spyAnchorer();
    const { inner } = fakeInner();
    const store = anchoredAuditStore(inner, anchorer, {
      mapPayload: (e) => (e.payload.callId === "skip-me" ? null : e.payload),
    });

    await store.commitAudit([
      auditRecord({ callId: "a0", seq: 0 }),
      auditRecord({ callId: "skip-me", seq: 1 }),
      auditRecord({ callId: "a2", seq: 2 }),
    ]);

    // The skipped record is absent and left no dangling pointer.
    expect(adds.map((a) => meta(a).call_id)).toEqual(["a0", "a2"]);
    expect(meta(adds[1]!).prev_event_id).toBe(adds[0]!.eventId);
  });

  it("sees the chain context alongside the payload", async () => {
    const seen: { type: string; sessionId: string; prevEventId: string | null }[] = [];
    const { anchorer } = spyAnchorer();
    const { inner } = fakeInner();
    const store = anchoredAuditStore(inner, anchorer, {
      mapPayload: (e) => {
        seen.push({ type: e.type, sessionId: e.sessionId, prevEventId: e.prevEventId });
        return e.payload;
      },
    });

    await store.commitAudit([auditRecord(), blockedRecord({ seq: 1 })]);

    expect(seen[0]).toEqual({ type: "interchange.tool_call", sessionId: "sess-a", prevEventId: null });
    expect(seen[1]!.type).toBe("interchange.tool_blocked");
    expect(seen[1]!.prevEventId).not.toBeNull();
  });
});

describe("lifecycle — explicit, no hidden exit hooks", () => {
  it("flushSession flushes only that session's batch and resolves its receipts", async () => {
    const { anchorer, batches } = spyAnchorer();
    const { inner } = fakeInner();
    const store = anchoredAuditStore(inner, anchorer);

    await store.commitAudit([
      auditRecord({ sessionId: "sess-a", callId: "a0" }),
      auditRecord({ sessionId: "sess-b", callId: "b0" }),
      auditRecord({ sessionId: "sess-a", callId: "a1", seq: 1 }),
    ]);

    const receipts = await store.flushSession("sess-a");

    expect(batches[0]!.flushes).toBe(1); // sess-a
    expect(batches[1]!.flushes).toBe(0); // sess-b untouched
    expect(receipts).toHaveLength(2);
  });

  it("flushSession of an unknown session resolves empty", async () => {
    const { anchorer } = spyAnchorer();
    const { inner } = fakeInner();
    const store = anchoredAuditStore(inner, anchorer);
    expect(await store.flushSession("never-seen")).toEqual([]);
  });

  it("close() closes every batch and resolves all receipts per session", async () => {
    const { anchorer, batches } = spyAnchorer();
    const { inner } = fakeInner();
    const store = anchoredAuditStore(inner, anchorer);

    await store.commitAudit([
      auditRecord({ sessionId: "sess-a", callId: "a0" }),
      auditRecord({ sessionId: "sess-b", callId: "b0" }),
    ]);
    await store.commitErrors([errorRecord({ sessionId: "sess-a", seq: 1 })]);

    const bySession = await store.close();

    expect(batches.every((b) => b.closes === 1)).toBe(true);
    expect([...bySession.keys()].sort()).toEqual(["sess-a", "sess-b"]);
    expect(bySession.get("sess-a")).toHaveLength(2);
    expect(bySession.get("sess-b")).toHaveLength(1);
  });

  it("onReceipts hands each session's receipts to the host at flushSession and close", async () => {
    const delivered: { sessionId: string; count: number }[] = [];
    const { anchorer } = spyAnchorer();
    const { inner } = fakeInner();
    const store = anchoredAuditStore(inner, anchorer, {
      onReceipts: (sessionId, receipts) => {
        delivered.push({ sessionId, count: receipts.length });
      },
    });

    await store.commitAudit([
      auditRecord({ sessionId: "sess-a", callId: "a0" }),
      auditRecord({ sessionId: "sess-b", callId: "b0" }),
    ]);

    await store.flushSession("sess-a");
    expect(delivered).toEqual([{ sessionId: "sess-a", count: 1 }]);

    await store.close();
    expect(delivered).toContainEqual({ sessionId: "sess-b", count: 1 });
  });
});

describe("provenance never crashes the agent", () => {
  it("a record whose arguments cannot serialize (circular) is warned and skipped", async () => {
    const warnings: string[] = [];
    const { anchorer, adds } = spyAnchorer();
    const { inner, calls } = fakeInner();
    const store = anchoredAuditStore(inner, anchorer, { warn: (m) => warnings.push(m) });

    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(
      store.commitAudit([auditRecord({ arguments: circular })]),
    ).resolves.toBeUndefined();

    expect(calls).toEqual([{ method: "commitAudit", count: 1 }]); // git commit still happened
    expect(adds).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("interchange.tool_call");
  });

  it("a BigInt in the result is warned and skipped, and the chain stays gapless", async () => {
    const warnings: string[] = [];
    const { anchorer, adds } = spyAnchorer();
    const { inner } = fakeInner();
    const store = anchoredAuditStore(inner, anchorer, { warn: (m) => warnings.push(m) });

    await store.commitAudit([
      auditRecord({ callId: "a0", seq: 0 }),
      auditRecord({ callId: "a1", seq: 1, result: { content: { n: 1n } as never, isError: false } }),
      auditRecord({ callId: "a2", seq: 2 }),
    ]);

    expect(adds.map((a) => meta(a).call_id)).toEqual(["a0", "a2"]);
    expect(meta(adds[1]!).prev_event_id).toBe(adds[0]!.eventId); // no dangling pointer
    expect(warnings).toHaveLength(1);
  });

  it("a throwing mapPayload is contained the same way", async () => {
    const warnings: string[] = [];
    const { anchorer, adds } = spyAnchorer();
    const { inner } = fakeInner();
    const store = anchoredAuditStore(inner, anchorer, {
      warn: (m) => warnings.push(m),
      mapPayload: () => {
        throw new Error("mapper bug");
      },
    });

    await expect(store.commitAudit([auditRecord()])).resolves.toBeUndefined();
    expect(adds).toHaveLength(0);
    expect(warnings[0]).toContain("mapper bug");
  });
});

describe("anchorRecordsFromCollector — hosts that hook the collector", () => {
  it("adds records to the right per-session batches without touching the inner store", async () => {
    const { anchorer, adds, batchOptions } = spyAnchorer();
    const { inner, calls } = fakeInner();
    const store = anchoredAuditStore(inner, anchorer);

    anchorRecordsFromCollector(store, [
      auditRecord({ sessionId: "sess-a", callId: "a0", seq: 0 }),
      auditRecord({ sessionId: "sess-b", callId: "b0", seq: 0 }),
      blockedRecord({ sessionId: "sess-a", seq: 1 }),
    ]);

    expect(calls).toHaveLength(0); // never delegates — the host already persisted
    expect(batchOptions).toHaveLength(2);
    expect(adds.map((a) => a.type)).toEqual([
      "interchange.tool_call",
      "interchange.tool_call",
      "interchange.tool_blocked",
    ]);
    expect(meta(adds[2]!).prev_event_id).toBe(adds[0]!.eventId); // same sess-a chain
  });
});

describe("resumeChains — chain continuity across process restarts", () => {
  it("the first record of a resumed session chains from the persisted head, not null", async () => {
    const { anchorer, adds } = spyAnchorer();
    const { inner } = fakeInner();
    const store = anchoredAuditStore(inner, anchorer, {
      resumeChains: { "sess-a": "evt-from-before-restart" },
    });

    await store.commitAudit([auditRecord()]);
    expect(meta(adds[0]!).prev_event_id).toBe("evt-from-before-restart");

    // The chain then advances normally within the new process.
    await store.commitAudit([auditRecord({ callId: "call-2", seq: 1 })]);
    expect(meta(adds[1]!).prev_event_id).toBe(adds[0]!.eventId);
  });

  it("sessions absent from resumeChains start a fresh chain", async () => {
    const { anchorer, adds } = spyAnchorer();
    const { inner } = fakeInner();
    const store = anchoredAuditStore(inner, anchorer, {
      resumeChains: { "some-other-session": "evt-x" },
    });

    await store.commitAudit([auditRecord()]);
    expect(meta(adds[0]!).prev_event_id).toBeNull();
  });
});
