import { describe, expect, it } from "vitest";

import { buildEventRecord, isValidEventType } from "../src/record";

const subject = { type: "producer" as const, producer_id: "acme-app" };
const HASH = "a".repeat(64);

describe("event_type grammar (profile §4)", () => {
  it("accepts reserved and adapter-namespaced types", () => {
    expect(isValidEventType("event")).toBe(true);
    expect(isValidEventType("checkpoint")).toBe(true);
    expect(isValidEventType("s3.object_stored")).toBe(true);
    expect(isValidEventType("vercel_ai.generation")).toBe(true);
    expect(isValidEventType("a.b.c")).toBe(true);
  });

  it("rejects malformed types", () => {
    for (const bad of ["", "Foo", "s3..x", ".event", "event.", "s3.Object", "x-y", "x y", "9x"]) {
      expect(isValidEventType(bad), bad).toBe(false);
    }
    expect(isValidEventType("a".repeat(65))).toBe(false);
  });
});

describe("buildEventRecord", () => {
  it("builds a §3.2-sectioned record with GENESIS for unchained events", () => {
    const record = buildEventRecord({ subject, contentHash: HASH, contentLength: 3 });
    expect(record).toEqual({
      payload_version: 1,
      spec_version: "ario.events/v1",
      event_type: "event",
      subject: { type: "producer", producer_id: "acme-app" },
      previous_hash: "GENESIS",
      event: { content_hash: HASH, content_length: 3 },
      context: {},
      metadata: {},
      extras: {},
    });
  });

  it("carries chain key + previous hash together", () => {
    const record = buildEventRecord({
      subject,
      contentHash: HASH,
      chainKey: "orders",
      previousHash: "b".repeat(64),
    });
    expect(record.previous_hash).toBe("b".repeat(64));
    expect(record.context).toEqual({ chain_key: "orders" });
  });

  it("rejects a chain key without a previous hash (and vice versa)", () => {
    expect(() => buildEventRecord({ subject, contentHash: HASH, chainKey: "orders" })).toThrow(
      /chain/i,
    );
    expect(() =>
      buildEventRecord({ subject, contentHash: HASH, previousHash: "b".repeat(64) }),
    ).toThrow(/chain/i);
  });

  it("keeps caller metadata isolated in the metadata section", () => {
    const record = buildEventRecord({
      subject,
      contentHash: HASH,
      metadata: { approver: "alice", event_type: "spoof" },
    });
    expect(record.metadata).toEqual({ approver: "alice", event_type: "spoof" });
    expect(record.event_type).toBe("event");
  });

  it("requires content_hash for event-shaped types", () => {
    expect(() => buildEventRecord({ subject })).toThrow(/content_hash/i);
    expect(() => buildEventRecord({ subject, type: "s3.object_stored" })).toThrow(
      /content_hash/i,
    );
  });

  it("rejects a malformed content hash", () => {
    expect(() => buildEventRecord({ subject, contentHash: "ZZ" })).toThrow(/content_hash/i);
    expect(() => buildEventRecord({ subject, contentHash: "A".repeat(64) })).toThrow(
      /content_hash/i,
    );
  });

  it("rejects malformed event types", () => {
    expect(() => buildEventRecord({ subject, type: "Bad.Type", contentHash: HASH })).toThrow(
      /event_type/i,
    );
  });

  it("rejects non-namespaced custom single-segment types (profile-reserved)", () => {
    expect(() => buildEventRecord({ subject, type: "custom", contentHash: HASH })).toThrow(
      /reserved/i,
    );
  });

  it("rejects a malformed previous hash", () => {
    expect(() =>
      buildEventRecord({ subject, contentHash: HASH, chainKey: "k", previousHash: "nope" }),
    ).toThrow(/previous_hash/i);
  });

  it("rejects subject string fields over 128 chars or with bad charset (family §2)", () => {
    expect(() =>
      buildEventRecord({
        subject: { type: "producer", producer_id: "x".repeat(129) },
        contentHash: HASH,
      }),
    ).toThrow(/subject/i);
    expect(() =>
      buildEventRecord({
        subject: { type: "producer", name: "has spaces!" },
        contentHash: HASH,
      }),
    ).toThrow(/subject/i);
  });
});
