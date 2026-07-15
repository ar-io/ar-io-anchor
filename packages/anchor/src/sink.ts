// The retention plug point (T9 Phase 1 — proof retention). A Sink turns the
// caller's documented "retain your receipts" obligation into a first-class,
// injected side effect: one durable row per event (its signed envelope +
// committed recordBytes + proof) and one per flushed checkpoint window.
//
// Injected exactly like Store (anchorer.ts AnchorerOptions → BatcherContext),
// so every adapter that only ever touches the Anchorer inherits durable proofs
// with zero per-adapter work. Retention lives BELOW the adapter seam by design.
//
// Invariants:
// - NO on-chain / envelope / record / tag / bundle change. With no sink
//   configured, behavior is byte-identical to today.
// - Upload-then-sink: a proof row is only ever written for an accepted tx (the
//   TxIdMismatch check stays upstream, in anchorer.ts's upload pipeline).
// - Sink writes are keyed by eventId / checkpointTxId → idempotent → retryable.
// - A sink error MUST NEVER reject a receipt or crash the host — it warns and
//   degrades to today's in-memory-only behavior (writeIntentSafely /
//   writeEventSafely / writeCheckpointSafely wrap every call).

import { bytesToHex, hexToBytes } from "@ar.io/proof";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import type { EventsEnvelope } from "./types.js";

// The "offered for anchoring" record, written at add()-time in batch mode
// before the proof exists. Minimal by design (keys only — raw bytes never
// enter the sink), so it preserves minimal disclosure even for a third-party
// CallbackSink. Idempotent on eventId.
export interface RetainedIntent {
  eventId: string;
  contentHash: string;
  ref?: string;
}

// One durable row per event, regardless of anchoring mode. `proof` is the only
// per-mode difference: `direct` for single-shot anchor(), `inclusion` for a
// batched leaf (the standalone RFC 9162 proof the receipt already carries).
export interface RetainedEvent {
  eventId: string;
  contentHash: string;
  envelope: EventsEnvelope;
  recordBytes: Uint8Array;
  ref?: string;
  // Retention truth for the DURABLE trace, mirroring the receipt's flag:
  //   true      — byte-exact content was persisted to the LogStore
  //   false     — LogStore put() failed; anchored best-effort
  //               (onRetentionError:"anchor-anyway-flag"), content NOT retained
  //   undefined — no LogStore configured (content retention not in use)
  // Without this on the durable row, a never-stored event is byte-indistinguishable
  // from a fully-retained one — the silent, audit-time-only failure this seam
  // exists to kill. `contentStored:false` MUST survive to disk, not just the receipt.
  contentStored?: boolean;
  proof:
    | { kind: "direct"; txId: string; gatewayUrl: string }
    | {
        kind: "inclusion";
        leafHash: string;
        leafIndex: number;
        leafCount: number;
        auditPath: string[];
        checkpointTxId: string;
      };
}

// One durable row per flushed window (the anchored checkpoint the window's
// events prove inclusion in). Idempotent on txId.
export interface RetainedCheckpoint {
  txId: string;
  envelope: EventsEnvelope;
  recordBytes: Uint8Array;
  merkleRoot: string;
  gatewayUrl: string;
}

export interface Sink {
  // Called at add()-time in batch mode (proof not yet known): the durable
  // "offered for anchoring" record. Idempotent on eventId. Optional — a
  // minimal sink that only wants proofs omits it; the recovery index
  // (SELECT WHERE proof IS NULL) degrades gracefully to unavailable.
  writeIntent?(intent: RetainedIntent): Promise<void>;
  // Called once per event when its proof exists (flush resolution /
  // single-shot upload acceptance). Patches or replaces the intent row.
  writeEvent(event: RetainedEvent): Promise<void>;
  // Called once per flushed window. Optional.
  writeCheckpoint?(checkpoint: RetainedCheckpoint): Promise<void>;
}

// A single tagged record — the shape CallbackSink funnels every write into and
// FsSink.read reconstructs. Lets a customer pipe all three write kinds into one
// existing log/queue consumer without implementing the full Sink interface.
export type SinkRecord =
  | { type: "intent"; intent: RetainedIntent }
  | { type: "event"; event: RetainedEvent }
  | { type: "checkpoint"; checkpoint: RetainedCheckpoint };

// CallbackSink — wraps a single function. The SDK is a provenance sidecar to
// whatever pipeline the customer already runs, not a competing transport.
export class CallbackSink implements Sink {
  constructor(private readonly fn: (record: SinkRecord) => void | Promise<void>) {}

  async writeIntent(intent: RetainedIntent): Promise<void> {
    await this.fn({ type: "intent", intent });
  }

  async writeEvent(event: RetainedEvent): Promise<void> {
    await this.fn({ type: "event", event });
  }

  async writeCheckpoint(checkpoint: RetainedCheckpoint): Promise<void> {
    await this.fn({ type: "checkpoint", checkpoint });
  }
}

// FsSink — local JSON-lines, for dev and short-lived scripts. One line per
// write, append-only. Uint8Array fields serialize as lowercase hex (the family
// convention). Synchronous fs so an intent line is durable the instant add()
// returns (no await race in the crash-recovery model). Reads via
// FsSink.read(path); apply last-writer-wins per key for idempotency.
export class FsSink implements Sink {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  private appendLine(row: unknown): void {
    appendFileSync(this.path, JSON.stringify(row) + "\n");
  }

  async writeIntent(intent: RetainedIntent): Promise<void> {
    this.appendLine({
      type: "intent",
      eventId: intent.eventId,
      contentHash: intent.contentHash,
      ...(intent.ref !== undefined ? { ref: intent.ref } : {}),
    });
  }

  async writeEvent(event: RetainedEvent): Promise<void> {
    this.appendLine({
      type: "event",
      eventId: event.eventId,
      contentHash: event.contentHash,
      ...(event.ref !== undefined ? { ref: event.ref } : {}),
      ...(event.contentStored !== undefined ? { contentStored: event.contentStored } : {}),
      envelope: event.envelope,
      recordBytes: bytesToHex(event.recordBytes),
      proof: event.proof,
    });
  }

  async writeCheckpoint(checkpoint: RetainedCheckpoint): Promise<void> {
    this.appendLine({
      type: "checkpoint",
      txId: checkpoint.txId,
      envelope: checkpoint.envelope,
      recordBytes: bytesToHex(checkpoint.recordBytes),
      merkleRoot: checkpoint.merkleRoot,
      gatewayUrl: checkpoint.gatewayUrl,
    });
  }

  // Read every row back, hex-decoding the Uint8Array fields. File order is
  // write order; the caller applies last-writer-wins per eventId/txId (an
  // event row supersedes its intent row). Missing file → no rows.
  static read(path: string): SinkRecord[] {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: SinkRecord[] = [];
    for (const line of text.split("\n")) {
      if (line.length === 0) continue;
      const row = JSON.parse(line) as Record<string, unknown>;
      if (row.type === "intent") {
        out.push({
          type: "intent",
          intent: {
            eventId: row.eventId as string,
            contentHash: row.contentHash as string,
            ...(row.ref !== undefined ? { ref: row.ref as string } : {}),
          },
        });
      } else if (row.type === "event") {
        out.push({
          type: "event",
          event: {
            eventId: row.eventId as string,
            contentHash: row.contentHash as string,
            ...(row.ref !== undefined ? { ref: row.ref as string } : {}),
            ...(row.contentStored !== undefined
              ? { contentStored: row.contentStored as boolean }
              : {}),
            envelope: row.envelope as EventsEnvelope,
            recordBytes: hexToBytes(row.recordBytes as string),
            proof: row.proof as RetainedEvent["proof"],
          },
        });
      } else if (row.type === "checkpoint") {
        out.push({
          type: "checkpoint",
          checkpoint: {
            txId: row.txId as string,
            envelope: row.envelope as EventsEnvelope,
            recordBytes: hexToBytes(row.recordBytes as string),
            merkleRoot: row.merkleRoot as string,
            gatewayUrl: row.gatewayUrl as string,
          },
        });
      }
    }
    return out;
  }
}

// ---- failure isolation ----------------------------------------------------
// Every core→sink call goes through one of these. They NEVER throw and NEVER
// reject: a sink failure warns and the proof stays in the receipt, exactly as
// today. This is the "degrade to current behavior" contract in one place.

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Fire-and-forget: add() is synchronous, so the intent write cannot be awaited.
// A synchronous throw (a non-async sink) or a rejected promise (an async one)
// both degrade to a warning.
export function writeIntentSafely(
  sink: Sink | undefined,
  warn: (message: string) => void,
  intent: RetainedIntent,
): void {
  if (!sink?.writeIntent) return;
  try {
    const p = sink.writeIntent(intent);
    if (p && typeof p.then === "function") {
      p.then(undefined, (err: unknown) =>
        warn(`[@ar.io/anchor] sink.writeIntent failed for ${intent.eventId}: ${errMsg(err)}`),
      );
    }
  } catch (err) {
    warn(`[@ar.io/anchor] sink.writeIntent failed for ${intent.eventId}: ${errMsg(err)}`);
  }
}

export async function writeEventSafely(
  sink: Sink | undefined,
  warn: (message: string) => void,
  event: RetainedEvent,
): Promise<void> {
  if (!sink) return;
  try {
    await sink.writeEvent(event);
  } catch (err) {
    warn(
      `[@ar.io/anchor] sink.writeEvent failed for ${event.eventId}; proof retained in receipt only: ${errMsg(err)}`,
    );
  }
}

export async function writeCheckpointSafely(
  sink: Sink | undefined,
  warn: (message: string) => void,
  checkpoint: RetainedCheckpoint,
): Promise<void> {
  if (!sink?.writeCheckpoint) return;
  try {
    await sink.writeCheckpoint(checkpoint);
  } catch (err) {
    warn(
      `[@ar.io/anchor] sink.writeCheckpoint failed for ${checkpoint.txId}: ${errMsg(err)}`,
    );
  }
}
