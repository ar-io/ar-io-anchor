// Opt-in disclosure: bundle a batch, but ALSO embed the raw bytes of one event
// so the file an auditor receives carries the raw logs AND their on-chain
// proofs together — one self-contained, verify-anywhere artifact.
//
//   node examples/07-disclose.mjs
//
// Disclosure is per-event and default-off. Your ON-CHAIN footprint is
// unchanged — the envelope still carries only the hash; the raw bytes live
// only in the file you choose to hand out. The embedded bytes ride inside the
// signed body (body_hash), so the disclosure is tamper-evident like everything
// else, and `sha256(bytes)` is asserted == the event's committed content_hash
// at assembly time (a mismatch throws).
import { writeFile } from "node:fs/promises";

import { createAnchorer } from "@ar.io/anchor";

const ario = createAnchorer();

// Batch three events. Keep the original bytes around — the receipt commits to
// their hash but never retains the bytes themselves (that's minimal disclosure),
// so disclosure means handing them back in.
const payloads = ["event 0 — the one we disclose", "event 1", "event 2"];
const batch = ario.batch({ maxEvents: 3, name: "disclose-demo" });
const handles = payloads.map((data, i) => batch.add({ data, metadata: { i } }));
const receipts = await Promise.all(handles.map((h) => h.receipt()));
await ario.close();

// Disclose ONLY event 0 — events 1 and 2 stay minimal (no raw bytes in the
// bundle). disclose is keyed by eventId; a string value is UTF-8 encoded.
const bundle = await ario.bundle(receipts, {
  disclose: { [receipts[0].eventId]: payloads[0] },
});

await writeFile("trace-bundle.json", JSON.stringify(bundle, null, 2));
console.log("wrote trace-bundle.json");
console.log("  event 0 discloses content:", "content" in bundle.body.events[0]);
console.log("  event 1 discloses content:", "content" in bundle.body.events[1]);

// Verify the whole thing — provenance for every event, plus the disclosed
// bytes for event 0 — with one command, no write SDK in the trust path:
//
//   npx @ar.io/proof verify trace-bundle.json
//
// The in-body content is checked automatically (no flag): the CLI recomputes
// sha256 of event 0's disclosed bytes and confirms they ARE the bytes whose
// hash was anchored — printing a `logs ✓` mark for that event.
console.log("\nverify with:  npx @ar.io/proof verify trace-bundle.json");
