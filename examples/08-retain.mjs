// Durable retention (T9): make "retain your receipts + the exact bytes you
// anchored" a first-class, injected side effect instead of the caller's homework.
//
//   • a Sink      persists one durable proof row per event (+ per checkpoint)
//   • a LogStore  persists the EXACT committed bytes, content-addressed
//
// Both are injected ONCE on the anchorer and apply to single anchor() and the
// batcher alike — every adapter (LangChain / Vercel / S3) inherits them for free.
// After this runs you can rebuild and re-verify the whole trace from disk, and
// prove "these exact bytes are the ones whose hashes were anchored" — the silent,
// audit-time-only failure (stored bytes ≠ committed hash) is structurally gone.
import { rm } from "node:fs/promises";

import { createAnchorer, FsSink, FsLogStore } from "@ar.io/anchor";
import { sha256Hex } from "@ar.io/proof";

const DIR = "retention-demo";
await rm(DIR, { recursive: true, force: true }); // fresh run

const ario = createAnchorer({
  sink: new FsSink(`${DIR}/proofs.jsonl`), // durable proof row per event + checkpoint
  logStore: new FsLogStore(`${DIR}/content`), // byte-exact content, content-addressed
  // onRetentionError defaults to "skip-anchor" (strict, recommended): if the
  // content store fails, the event fails LOUDLY rather than anchoring a proof
  // whose bytes you never kept. Set "anchor-anyway-flag" for best-effort.
});

const batch = ario.batch({ maxEvents: 3 });
const receipts = await Promise.all(
  ["step-1", "step-2", "step-3"].map((s) =>
    batch.add({ data: JSON.stringify({ step: s, at: new Date().toISOString() }) }).receipt(),
  ),
);
await ario.close(); // flush the window
console.log(`anchored ${receipts.length} events in one checkpoint write\n`);

// --- Everything below reads from DISK ONLY — no in-memory receipts, no network.

const rows = FsSink.read(`${DIR}/proofs.jsonl`);
const events = rows.filter((r) => r.type === "event").map((r) => r.event);
const checkpoints = rows.filter((r) => r.type === "checkpoint");
console.log(`durable trace on disk: ${events.length} event rows + ${checkpoints.length} checkpoint row`);

// Re-open the content store and prove each retained blob is byte-exact:
// sha256(stored bytes) === the content_hash that was committed on-chain.
const store = new FsLogStore(`${DIR}/content`);
for (const ev of events) {
  const bytes = await store.get(ev.eventId);
  const matches = bytes !== null && (await sha256Hex(bytes)) === ev.contentHash;
  console.log(
    `  ${ev.eventId.slice(0, 8)}…  contentStored=${ev.contentStored ?? "(n/a)"}  bytes match committed hash: ${matches}`,
  );
}

console.log(`\nrebuild + re-verify the whole trace from ./${DIR}/ — retention is now the SDK's job, not yours.`);
