// Batch five events into ONE Arweave write. Every event still gets its own
// inclusion proof, verifiable offline against the checkpoint.
import { createAnchorer } from "@ar.io/anchor";
import { leafHash, verifyInclusion } from "@ar.io/proof";

const ario = createAnchorer();
const batch = ario.batch({
  maxEvents: 5, // flush when full…
  maxAge: 30_000, // …or 30s after the first buffered event…
  flushOnIdle: 2_000, // …or 2s after the last add. First trigger wins.
});

const handles = [];
for (let i = 0; i < 5; i++) {
  // add() is synchronous; receipt() resolves when the window flushes.
  handles.push(batch.add({ data: `event ${i}`, metadata: { i } }));
}
const receipts = await Promise.all(handles.map((h) => h.receipt()));
await ario.close(); // always close — flushes anything still buffered

console.log("one checkpoint for all five:", receipts[0].checkpointTxId);
console.log("explorer:", `https://viewblock.io/arweave/tx/${receipts[0].checkpointTxId}`);

// Verify one event's inclusion offline: its leaf hash is computed from the
// event's own signed envelope bytes, then the audit path must reproduce the
// root committed in the checkpoint record.
const r = receipts[2];
const fromHex = (h) => Uint8Array.from(Buffer.from(h, "hex"));
const leaf = await leafHash(r.envelopeBytes);
const included = await verifyInclusion(
  leaf,
  r.leafIndex,
  r.leafCount,
  r.auditPath.map(fromHex),
  fromHex(r.root),
);
console.log(`event ${r.leafIndex} of ${r.leafCount} provably included:`, included);
