// Generate a golden ario.evidence/v1 / ario.anchor.trace/v1 bundle by anchoring
// a small real batch and running @ar.io/anchor's toEvidenceBundle over the
// resulting receipts. The output JSON is committed as a cross-repo golden
// fixture in ar-io-proof (ts/test/fixtures/) so @ar.io/proof's verifier proves
// emit↔verify agree against frozen producer bytes — no runtime cross-linking.
//
//   node scripts/gen-evidence-fixture.mjs [out.json]
//
// Determinism: a fixed signer seed + fixed event payloads + a fake batcher
// clock pin the merkle tree, inclusion proofs, public_key, and window
// timestamps. The committed file is a FROZEN snapshot — the per-envelope
// `signed_at` is baked in at generation time (buildEnvelope stamps wall-clock
// `signed_at` and does not thread a clock), so re-running mints fresh
// signatures. Regenerate intentionally and re-commit when the format changes.
//
// Run AFTER `npm run build --workspace @ar.io/anchor` (imports built dist).

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  createAnchorer,
  LocalEd25519Signer,
  toEvidenceBundle,
  txIdFromDataItem,
} from "../packages/anchor/dist/index.js";

const SEED_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
// Pin the wrapper's generated_at / previous_hash for a stable wrapper shape.
const GENERATED_AT = "2026-06-22T00:00:00.000Z";
const WINDOW_BASE_MS = Date.UTC(2026, 5, 22, 0, 0, 0); // 2026-06-22T00:00:00Z

// Stub uploader: deterministic TX IDs derived from the data-item bytes (no
// network). Mirrors the StubUploader the anchor evidence tests use.
class StubUploader {
  async upload(dataItem) {
    return { txId: await txIdFromDataItem(dataItem), raw: {} };
  }
}

// A fake monotonic clock so the checkpoint window.start/window.end are pinned.
function fakeTimers() {
  let t = WINDOW_BASE_MS;
  return {
    now: () => t,
    setTimeout: () => {
      t += 1000; // each scheduled flush advances the clock 1s, deterministically
      return 0;
    },
    clearTimeout: () => {},
  };
}

async function main() {
  const out =
    process.argv[2] ??
    fileURLToPath(new URL("../packages/anchor/evidence-fixture.json", import.meta.url));

  const signer = LocalEd25519Signer.fromSeedHex(SEED_HEX);
  const anchorer = createAnchorer({
    signer,
    subject: { type: "producer", producer_id: "fixture-producer" },
    environment: "dev",
    uploader: new StubUploader(),
    warn: () => {},
    timers: fakeTimers(),
  });

  // Anchor a 3-event window: one shared checkpoint, three inclusion proofs.
  const batch = anchorer.batch({ maxEvents: 3, name: "fixture" });
  const handles = [
    batch.add({ type: "llm.call", data: "fixture-event-0", metadata: { i: 0 } }),
    batch.add({ type: "llm.call", data: "fixture-event-1", metadata: { i: 1 } }),
    batch.add({ type: "llm.call", data: "fixture-event-2", metadata: { i: 2 } }),
  ];
  const receipts = await Promise.all(handles.map((h) => h.receipt()));

  const bundle = await toEvidenceBundle(receipts, {
    signer,
    issuer: { kind: "producer", producer_id: "fixture-producer" },
    generatedAt: GENERATED_AT,
    previousHash: "GENESIS",
    // Disclose event 0's raw bytes in-body (events 1 & 2 stay withheld) so the
    // golden exercises both contentOk:true (disclosed) and contentOk:null
    // (undisclosed) verifier paths. The string is utf8-encoded and asserted
    // against the event's committed content_hash before signing.
    disclose: { [receipts[0].eventId]: "fixture-event-0" },
  });

  await writeFile(out, JSON.stringify(bundle, null, 2) + "\n", "utf8");
  process.stderr.write(
    `wrote ${out}\n` +
      `  spec_version ${bundle.spec_version} / ${bundle.body_type}\n` +
      `  events ${bundle.body.events.length} checkpoints ${bundle.body.checkpoints.length}\n` +
      `  public_key ${bundle.public_key}\n`,
  );
}

main().catch((e) => {
  process.stderr.write(`gen-evidence-fixture failed: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exitCode = 1;
});
