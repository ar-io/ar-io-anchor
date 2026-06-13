// Lane 4B spike A — LangChain.js seam: BaseCallbackHandler → ario.batch()
// Proof-of-life: a real LangChain runnable (FakeListChatModel — no network)
// drives callbacks into @ar.io/anchor's Merkle batcher; every event gets an
// inclusion receipt verified OFFLINE via @ar.io/proof. StubUploader = no
// network anywhere.
import { createAnchorer, txIdFromDataItem } from "@ar.io/anchor";
import { verifyInclusion, verifyEnvelope, hexToBytes, sha256Hex } from "@ar.io/proof";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { FakeListChatModel } from "@langchain/core/utils/testing";

// Honest stub: txId derived from the actual data-item bytes (mirrors seam 4).
const uploader = {
  items: [],
  async upload(dataItem) {
    this.items.push(dataItem);
    return { txId: await txIdFromDataItem(dataItem), raw: {} };
  },
};

const ario = createAnchorer({ uploader, warn: () => {} }); // dev mode, zero-config
const batch = ario.batch({ maxEvents: 100, maxAge: 60_000, name: "langchain-spike" });

// The adapter seam: one BaseCallbackHandler subclass, each callback is a
// synchronous batch.add() — nothing blocks the LLM hot path.
class ArioAnchorHandler extends BaseCallbackHandler {
  name = "ario-anchor";
  pending = [];
  #add(type, payload, runId, parentRunId) {
    const handle = batch.add({
      type,
      data: JSON.stringify(payload),
      metadata: { run_id: runId, parent_run_id: parentRunId ?? null },
    });
    this.pending.push({ type, receipt: handle.receipt() });
  }
  handleChatModelStart(_llm, messages, runId, parentRunId) {
    this.#add("langchain.chat_model_start", { messages }, runId, parentRunId);
  }
  handleLLMStart(_llm, prompts, runId, parentRunId) {
    this.#add("langchain.llm_start", { prompts }, runId, parentRunId);
  }
  handleLLMEnd(output, runId, parentRunId) {
    this.#add("langchain.llm_end", { output }, runId, parentRunId);
  }
  handleToolStart(_tool, input, runId, parentRunId) {
    this.#add("langchain.tool_start", { input }, runId, parentRunId);
  }
  handleToolEnd(output, runId, parentRunId) {
    this.#add("langchain.tool_end", { output }, runId, parentRunId);
  }
  handleChainStart(_chain, inputs, runId, parentRunId) {
    this.#add("langchain.chain_start", { inputs }, runId, parentRunId);
  }
  handleChainEnd(outputs, runId, parentRunId) {
    this.#add("langchain.chain_end", { outputs }, runId, parentRunId);
  }
}

const handler = new ArioAnchorHandler();
const model = new FakeListChatModel({ responses: ["anchored response one", "anchored response two"] });

// Two invocations = a small burst, the batcher's natural shape.
await model.invoke("What is provenance?", { callbacks: [handler] });
await model.invoke("And why batch it?", { callbacks: [handler] });

await batch.close(); // explicit flush — the adapter's shutdown contract

// Every callback event must hold an offline-verifiable inclusion proof.
let verified = 0;
for (const { type, receipt } of handler.pending) {
  const r = await receipt;
  // Offline verification, three layers:
  // 1. payload binding: the committed record hashes to the envelope's payload_hash;
  // 2. Ed25519 signature over the envelope (via the kernel verifier — its
  //    accept-set doesn't list ario.events/v1 yet [ESCALATED], but it still
  //    reports signatureOk independently);
  // 3. RFC 9162 inclusion of this event's leaf in the checkpoint root.
  const bindOk = (await sha256Hex(r.recordBytes)) === r.envelope.payload_hash;
  const envRes = await verifyEnvelope(r.envelope);
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
console.log(`\nPROOF OF LIFE: ${verified} LangChain events → ${uploader.items.length} Arweave write(s), every event offline-verified.`);
