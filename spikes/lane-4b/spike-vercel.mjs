// Lane 4B spike B — Vercel AI SDK seam: LanguageModelMiddleware → ario.batch()
// Proof-of-life: wrapLanguageModel middleware (wrapGenerate + wrapStream)
// feeds @ar.io/anchor's Merkle batcher; driven by MockLanguageModelV3 from
// ai/test (no network), verified offline via @ar.io/proof.
import { createAnchorer, txIdFromDataItem } from "@ar.io/anchor";
import { verifyInclusion, verifyEnvelope, hexToBytes, sha256Hex } from "@ar.io/proof";
import { generateText, streamText, wrapLanguageModel } from "ai";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";

const uploader = {
  items: [],
  async upload(dataItem) {
    this.items.push(dataItem);
    return { txId: await txIdFromDataItem(dataItem), raw: {} };
  },
};
const ario = createAnchorer({ uploader, warn: () => {} });
const batch = ario.batch({ maxEvents: 100, maxAge: 60_000, name: "vercel-spike" });

// The adapter seam: one LanguageModelMiddleware. Generate path anchors the
// call + result; stream path anchors on stream completion (flush hook).
const pending = [];
const add = (type, payload) =>
  pending.push({ type, receipt: batch.add({ type, data: JSON.stringify(payload) }).receipt() });

const anchorMiddleware = {
  specificationVersion: "v3",
  wrapGenerate: async ({ doGenerate, params }) => {
    add("vercel_ai.generate_start", { prompt: params.prompt });
    const result = await doGenerate();
    add("vercel_ai.generate_end", { content: result.content, usage: result.usage });
    return result;
  },
  wrapStream: async ({ doStream, params }) => {
    add("vercel_ai.stream_start", { prompt: params.prompt });
    const { stream, ...rest } = await doStream();
    const chunks = [];
    const tap = new TransformStream({
      transform(chunk, controller) {
        chunks.push(chunk);
        controller.enqueue(chunk);
      },
      flush() {
        add("vercel_ai.stream_end", { parts: chunks.length });
      },
    });
    return { stream: stream.pipeThrough(tap), ...rest };
  },
};

const model = wrapLanguageModel({
  model: new MockLanguageModelV3({
    doGenerate: async () => ({
      finishReason: "stop",
      usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
      content: [{ type: "text", text: "anchored generation" }],
      warnings: [],
    }),
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: "text-start", id: "1" },
        { type: "text-delta", id: "1", delta: "anchored " },
        { type: "text-delta", id: "1", delta: "stream" },
        { type: "text-end", id: "1" },
        { type: "finish", finishReason: "stop", usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 } },
      ]),
    }),
  }),
  middleware: anchorMiddleware,
});

await generateText({ model, prompt: "What is provenance?" });
const { textStream } = streamText({ model, prompt: "And streamed?" });
for await (const _ of textStream) {
  /* consume */
}

await batch.close();

let verified = 0;
for (const { type, receipt } of pending) {
  const r = await receipt;
  const bindOk = (await sha256Hex(r.recordBytes)) === r.envelope.payload_hash;
  const envRes = await verifyEnvelope(r.envelope); // accept-set lag escalated; signatureOk is authoritative here
  const incOk = await verifyInclusion(
    hexToBytes(r.leafHash),
    r.leafIndex,
    r.leafCount,
    r.auditPath.map(hexToBytes),
    hexToBytes(r.root),
  );
  if (!bindOk || !envRes.signatureOk || !incOk)
    throw new Error(`${type}: bind=${bindOk} sig=${envRes.signatureOk} inc=${incOk}`);
  verified++;
  console.log(`OK ${type}  leaf ${r.leafIndex}/${r.leafCount}  checkpoint ${r.checkpointTxId.slice(0, 12)}…`);
}
console.log(`\nPROOF OF LIFE: ${verified} Vercel AI events (generate + stream) → ${uploader.items.length} Arweave write(s), every event offline-verified.`);
