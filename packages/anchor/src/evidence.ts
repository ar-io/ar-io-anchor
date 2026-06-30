// toEvidenceBundle — serialize a set of InclusionReceipts into ONE signed,
// portable, self-verifying ario.evidence/v1 bundle (ar-io-proof
// specs/evidence-bundle.md §5.1, body_type ario.anchor.trace/v1).
//
// This is the producer side of the "verify yourself" story: a producer
// collects receipts and emits a trace bundle; an auditor verifies the whole
// thing with `npx @ar.io/proof verify <bundle>` — no write SDK required. The
// wrapper is signed by the anchorer's own signer, so the bundle itself is
// tamper-evident; body_hash = SHA-256(JCS(body)) commits to the whole trace.
//
// Wrap-don't-merge: the body is the receipts' envelopes + checkpoints +
// inclusion proofs, structurally unchanged. Uint8Array fields (record_bytes,
// hashes, audit-path entries) serialize as lowercase hex — the family
// convention. The kernel (@ar.io/proof) is the single source of JCS/SHA-256
// truth; this module never re-implements canonicalization.

import { bytesToHex, jcs, sha256Hex, utf8 } from "@ar.io/proof";

import type { InclusionReceipt } from "./batch.js";
import type { EventsEnvelope, EventsSubject, Signer } from "./types.js";

export const EVIDENCE_SPEC_VERSION = "ario.evidence/v1";
export const ANCHOR_TRACE_BODY_TYPE = "ario.anchor.trace/v1";

// The bundle is signed with the SDK's baseline alg; mirrors the envelope
// signing alg (Ed25519) so a verifier that already verifies a family envelope
// verifies this with the same primitives (evidence-bundle §1).
export const EVIDENCE_SIGNATURE_ALG = "ed25519";

export interface EvidenceIssuer {
  kind: string;
  tenant_id?: string;
  agent_id?: string;
  producer_id?: string;
}

export interface EvidenceVerdict {
  status: string;
  summary?: string;
  counts?: Record<string, number>;
  as_of?: string;
}

export interface TraceCheckpointBody {
  tx_id: string;
  envelope: EventsEnvelope;
  record_bytes: string; // hex of JCS(checkpoint record)
  merkle_root: string; // hex
}

export interface TraceInclusionBody {
  leaf_hash: string;
  leaf_index: number;
  leaf_count: number;
  audit_path: string[];
  checkpoint_tx_id: string;
}

export interface TraceEventBody {
  envelope: EventsEnvelope;
  record_bytes?: string; // hex of JCS(event record); omitted when withheld
  // Opt-in: the event's raw bytes, lowercase hex, disclosed INSIDE the signed
  // body (so the bundle is self-contained and the disclosure is tamper-evident
  // under body_hash). Omitted entirely under the default minimal-disclosure
  // recipe. sha256(content) is asserted == record.event.content_hash at assembly.
  content?: string;
  inclusion: TraceInclusionBody;
}

export interface AnchorTraceBody {
  checkpoints: TraceCheckpointBody[];
  events: TraceEventBody[];
}

export interface EvidenceBundle {
  spec_version: string;
  body_type: string;
  issuer: EvidenceIssuer;
  generated_at: string;
  gateway: string | null;
  verdict: EvidenceVerdict;
  body: AnchorTraceBody;
  body_hash: string;
  previous_hash: string;
  signature_alg: string;
  public_key: string;
  signature: string;
}

export interface ToEvidenceBundleOptions {
  // The producer's signer (the anchorer's existing signer) — signs the wrapper
  // with the SAME key the receipts' envelopes are signed with.
  signer: Signer;
  // Identity context carried alongside the load-bearing public_key.
  issuer?: EvidenceIssuer;
  // The delivery surface, named-not-trusted. Defaults to the receipts' gateway.
  gateway?: string | null;
  // Override the timestamp (deterministic tests). Defaults to now.
  generatedAt?: string;
  // Chain pointer over successive exports (evidence-bundle §2). Defaults GENESIS.
  previousHash?: string;
  // Override the one-line verdict summary; counts/status are always recomputed.
  summary?: string;
  // Opt-in raw-byte disclosure, keyed by eventId. Minimal disclosure never
  // retained the raw bytes (the receipt carries only eventId + recordBytes), so
  // the caller hands them back in here. Each disclosed event embeds its bytes as
  // events[].content (lowercase hex) inside the SIGNED body — the bundle becomes
  // one self-contained file (raw logs + on-chain locations) and the disclosure
  // rides body_hash, so it stays tamper-evident. A string value is UTF-8 encoded.
  // Default off: with no disclose map the output is byte-identical to before.
  // For each entry sha256(bytes) MUST equal that event's committed
  // record.event.content_hash, else assembly throws (catches caller misuse).
  // Keys for eventIds not in this receipt set are ignored — so one disclose map
  // can be reused across bundles over disjoint receipt subsets.
  disclose?: Record<string /* eventId */, Uint8Array | string>;
}

const UINT8 = (b: Uint8Array): string => bytesToHex(b);

// The committed checkpoint record carries the merkle_root; read it back out so
// the bundle's checkpoints[].merkle_root is the recomputed value, not a guess.
function merkleRootOfCheckpoint(recordBytes: Uint8Array): string {
  const record = JSON.parse(new TextDecoder().decode(recordBytes)) as {
    event?: { merkle_root?: unknown };
  };
  const root = record.event?.merkle_root;
  if (typeof root !== "string") {
    throw new Error("toEvidenceBundle: checkpoint record has no string event.merkle_root");
  }
  return root;
}

// Read the committed content_hash from an event record (parse its JCS bytes).
// Disclosure asserts the caller-supplied raw bytes hash to THIS value. A record
// with no event.content_hash (checkpoints, content-less event shapes) is not
// disclosable — throw so the misuse is loud, not a silent no-op.
function contentHashOfRecord(recordBytes: Uint8Array, eventId: string): string {
  const record = JSON.parse(new TextDecoder().decode(recordBytes)) as {
    event?: { content_hash?: unknown };
  };
  const hash = record.event?.content_hash;
  if (typeof hash !== "string") {
    throw new Error(`toEvidenceBundle: event ${eventId} has no event.content_hash — not disclosable`);
  }
  return hash;
}

function issuerFromSubject(subject: EventsSubject | undefined, override?: EvidenceIssuer): EvidenceIssuer {
  if (override) return override;
  const issuer: EvidenceIssuer = { kind: "producer" };
  if (subject?.producer_id !== undefined) issuer.producer_id = subject.producer_id;
  return issuer;
}

// Assemble + SIGN an ario.evidence/v1 / ario.anchor.trace/v1 bundle from a set
// of InclusionReceipts. Async because signing is async.
export async function toEvidenceBundle(
  receipts: InclusionReceipt[],
  options: ToEvidenceBundleOptions,
): Promise<EvidenceBundle> {
  if (!Array.isArray(receipts) || receipts.length === 0) {
    throw new Error("toEvidenceBundle: at least one InclusionReceipt is required");
  }
  if (!options || typeof options.signer !== "object") {
    throw new Error("toEvidenceBundle: a signer is required (the anchorer's signer)");
  }

  // 1. De-duplicate the shared checkpoint(s). Events that landed in the same
  //    anchored window reference one checkpoint entry by checkpoint_tx_id.
  const checkpoints = new Map<string, TraceCheckpointBody>();
  for (const r of receipts) {
    if (checkpoints.has(r.checkpointTxId)) continue;
    checkpoints.set(r.checkpointTxId, {
      tx_id: r.checkpointTxId,
      envelope: r.checkpointEnvelope,
      record_bytes: UINT8(r.checkpointRecordBytes),
      merkle_root: merkleRootOfCheckpoint(r.checkpointRecordBytes),
    });
  }

  // 2. Events reference their checkpoint by tx_id and carry their committed
  //    record (external commitment) + inclusion proof. When the caller opts into
  //    disclosure for an event, its raw bytes are embedded (hex) in the body too,
  //    asserted against the record's committed content_hash before signing.
  const disclose = options.disclose;
  const events: TraceEventBody[] = await Promise.all(
    receipts.map(async (r): Promise<TraceEventBody> => {
      const event: TraceEventBody = {
        envelope: r.envelope,
        record_bytes: UINT8(r.recordBytes),
        inclusion: {
          leaf_hash: r.leafHash,
          leaf_index: r.leafIndex,
          leaf_count: r.leafCount,
          audit_path: [...r.auditPath],
          checkpoint_tx_id: r.checkpointTxId,
        },
      };
      const supplied = disclose?.[r.eventId];
      if (supplied !== undefined) {
        const bytes = typeof supplied === "string" ? utf8(supplied) : supplied;
        const committed = contentHashOfRecord(r.recordBytes, r.eventId);
        if ((await sha256Hex(bytes)) !== committed) {
          throw new Error(
            `toEvidenceBundle: disclosed content for ${r.eventId} does not match committed content_hash`,
          );
        }
        event.content = UINT8(bytes);
      }
      return event;
    }),
  );

  const body: AnchorTraceBody = {
    checkpoints: [...checkpoints.values()],
    events,
  };

  // 3. Verdict — recomputed (principle 3): every receipt is, by construction, a
  //    fully anchored inclusion proof, so the trace is "verified". counts make
  //    the rollup machine-readable; an auditor's verifier recomputes it anyway.
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const verdict: EvidenceVerdict = {
    status: "verified",
    summary:
      options.summary ??
      `${events.length} event(s) anchored across ${body.checkpoints.length} checkpoint(s)`,
    counts: { verified: events.length, checkpoints: body.checkpoints.length },
    as_of: generatedAt,
  };

  // 4. Sign the wrapper: body_hash, then strip-and-canonicalize exactly like an
  //    envelope (evidence-bundle §4) — JCS(bundle minus signature), Ed25519.
  const bodyHash = await sha256Hex(utf8(jcs(body)));
  const publicKey = await options.signer.publicKey();

  const preSignature: Omit<EvidenceBundle, "signature"> = {
    spec_version: EVIDENCE_SPEC_VERSION,
    body_type: ANCHOR_TRACE_BODY_TYPE,
    issuer: issuerFromSubject(firstSubject(receipts), options.issuer),
    generated_at: generatedAt,
    gateway: options.gateway ?? gatewayOf(receipts),
    verdict,
    body,
    body_hash: bodyHash,
    previous_hash: options.previousHash ?? "GENESIS",
    signature_alg: EVIDENCE_SIGNATURE_ALG,
    public_key: bytesToHex(publicKey),
  };

  const signature = await options.signer.sign(utf8(jcs(preSignature)));
  if (signature.length !== 64) {
    throw new Error(`toEvidenceBundle: signer returned a ${signature.length}-byte signature, want 64`);
  }

  return { ...preSignature, signature: bytesToHex(signature) };
}

// The receipts share a producer; their subject is on the event records, not the
// receipt — so we cannot read it directly. We default issuer to { kind:
// "producer" } unless the caller passes one. (The producer_id lives in the
// signed record bytes; an auditor reads it from there, not the wrapper.)
function firstSubject(_receipts: InclusionReceipt[]): EventsSubject | undefined {
  return undefined;
}

// The checkpoint gateway URL (the delivery surface) — named, not trusted.
function gatewayOf(receipts: InclusionReceipt[]): string | null {
  const url = receipts[0]?.gatewayUrl;
  if (!url) return null;
  // Strip the trailing /<txid> so the named surface is the gateway, not one tx.
  const m = /^(.*)\/[^/]+$/.exec(url);
  return m ? m[1]! : url;
}
