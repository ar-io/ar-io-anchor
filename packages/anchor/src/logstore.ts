// The content-retention plug point (T9 Phase 2 — byte-exact content
// retention). A LogStore is the SINGLE ingestion point that fans the exact
// committed bytes out to both the hasher and durable storage: the SDK hands
// logStore.put() the SAME Uint8Array it hashed, at add()/anchor() time. That
// makes "stored bytes ≠ committed content_hash" structurally impossible — the
// silent, permanent, audit-time-only failure this seam exists to kill (a
// customer re-serializing "the same" event through their own logger persists
// different bytes and a proof that can never verify).
//
// Injected exactly like Store / Sink (anchorer.ts AnchorerOptions →
// BatcherContext), so every adapter that only touches the Anchorer inherits
// byte-exact content retention with zero per-adapter work. Retention lives
// BELOW the adapter seam by design.
//
// Invariants:
// - NO on-chain / envelope / record / tag / bundle format change beyond
//   populating the EXISTING payload_ref / ref fields. With no logStore
//   configured, behavior is byte-identical to today.
// - Content is known SYNCHRONOUSLY at add()/anchor() (not at flush), so the
//   store-before-anchor ordering (strict mode) adds NO anchoring latency.
// - put() is idempotent on eventId (content-addressing on contentHash makes
//   retries trivially safe).

import { bytesToHex } from "@ar.io/proof";
import { sha256 } from "@noble/hashes/sha2";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Handed to put() once per event with the EXACT committed bytes.
export interface StoredContent {
  eventId: string;
  contentHash: string; // sha256 of exactly the bytes below (lowercase hex)
  content: Uint8Array; // the same buffer that was hashed
  contentType?: string;
  ref?: string; // caller-supplied locator, if any (see payload_ref binding)
  metadata?: Record<string, unknown>;
}

export interface LogStore {
  // Called once per event with the exact committed bytes, at add()/anchor()
  // time (content is known synchronously — this does NOT wait for flush).
  // Idempotent on eventId. Returns an optional CONTENT-ADDRESSED locator for
  // the stored copy (derivable from contentHash so it is stable between add()
  // and flush and immutable across retries — the ref is signed).
  put(content: StoredContent): Promise<{ ref?: string } | void>;
  // Optional: retrieval for the export path (auto-disclosed bundles) and for
  // re-verification tooling. Keyed by eventId.
  get?(eventId: string): Promise<Uint8Array | null>;
}

// Retention ordering when a LogStore is configured (BDFL-ratified default:
// strict). "skip-anchor" = store-before-anchor; a put() failure fails the
// event LOUDLY (never anchors it) but leaves it enumerable. "anchor-anyway-
// flag" = best-effort; a put() failure warns and anchors anyway with
// contentStored:false on the receipt.
export type RetentionErrorMode = "skip-anchor" | "anchor-anyway-flag";

export const DEFAULT_RETENTION_MODE: RetentionErrorMode = "skip-anchor";

// CallbackLogStore — wrap a single put function to pipe the committed bytes
// into a pipeline the customer already runs, with the contract made explicit:
// PERSIST THESE BYTES VERBATIM or your proofs won't verify. Return a content-
// addressed ref (e.g. derived from contentHash) to bind the location into the
// signed proof. get() is not provided (a raw callback has no retrieval side).
export class CallbackLogStore implements LogStore {
  constructor(
    private readonly fn: (
      content: StoredContent,
    ) => void | { ref?: string } | Promise<void | { ref?: string }>,
  ) {}

  async put(content: StoredContent): Promise<{ ref?: string } | void> {
    return this.fn(content);
  }
}

// FsLogStore — dev/local content-addressed store over node:fs. Content is
// stored ONCE per distinct contentHash at `<base>/content/<contentHash>`
// (content-addressed → idempotent, retry-safe, deduped), with a per-event
// pointer at `<base>/events/<h(eventId)>` mapping eventId → contentHash so
// get(eventId) can resolve it. put() returns a stable file:// ref to the
// content-addressed blob (derivable from contentHash + base). get supported.
export class FsLogStore implements LogStore {
  private readonly contentDir: string;
  private readonly eventsDir: string;

  constructor(baseDir: string) {
    this.contentDir = join(baseDir, "content");
    this.eventsDir = join(baseDir, "events");
    mkdirSync(this.contentDir, { recursive: true });
    mkdirSync(this.eventsDir, { recursive: true });
  }

  // contentHash is validated lowercase sha256 hex by the core before it ever
  // reaches a store, so it is always a safe path segment. The eventId may be
  // caller-supplied and arbitrary, so its pointer file is named by a hash of
  // the id (never the raw id) — no path-traversal surface.
  private contentPath(contentHash: string): string {
    return join(this.contentDir, contentHash);
  }
  private eventPath(eventId: string): string {
    return join(this.eventsDir, bytesToHex(sha256(new TextEncoder().encode(eventId))));
  }

  async put(content: StoredContent): Promise<{ ref: string }> {
    const path = this.contentPath(content.contentHash);
    // Content-addressed: same hash ⇒ same bytes, so an overwrite is a no-op.
    writeFileSync(path, content.content);
    writeFileSync(
      this.eventPath(content.eventId),
      JSON.stringify({
        contentHash: content.contentHash,
        ...(content.contentType !== undefined ? { contentType: content.contentType } : {}),
      }),
    );
    return { ref: pathToFileURL(path).href };
  }

  async get(eventId: string): Promise<Uint8Array | null> {
    let pointer: string;
    try {
      pointer = readFileSync(this.eventPath(eventId), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    const { contentHash } = JSON.parse(pointer) as { contentHash: string };
    try {
      const buf = readFileSync(this.contentPath(contentHash));
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }
}

// ---- core-side put runner --------------------------------------------------
// The single place the core calls put(). NEVER throws: returns a discriminated
// result so anchorer.ts / batch.ts apply strict vs. best-effort uniformly. A
// non-string / absent ref return degrades to "stored, no ref".

export async function runPut(
  logStore: LogStore,
  content: StoredContent,
): Promise<{ ok: true; ref?: string } | { ok: false; error: unknown }> {
  try {
    const res = await logStore.put(content);
    const ref =
      res && typeof res === "object" && typeof (res as { ref?: unknown }).ref === "string"
        ? (res as { ref: string }).ref
        : undefined;
    return ref !== undefined ? { ok: true, ref } : { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

// The best-effort warn line (onRetentionError: "anchor-anyway-flag"): the event
// is anchored with contentStored:false so it stays enumerable, not silent.
export function retentionWarnMessage(eventId: string, error: unknown): string {
  return (
    `[@ar.io/anchor] logStore.put failed for ${eventId}; anchoring anyway ` +
    `(onRetentionError: "anchor-anyway-flag") with contentStored:false: ` +
    `${error instanceof Error ? error.message : String(error)}`
  );
}
