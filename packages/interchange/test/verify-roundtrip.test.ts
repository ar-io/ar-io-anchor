// Verify round-trip (PRD testing seams 5 + 8, network-free): real signing
// through the CryptoProvider adapter and real verification, stub upload.
// Proves (1) signerFromCryptoProvider produces signatures the @ar.io/proof
// kernel accepts against the provider's own public key, and (2) records
// anchored through the decorator verify GREEN end-to-end — envelope
// signature, payload binding, and Merkle inclusion — using only the
// read-only verifier.

import { createAnchorer, LocalEd25519Signer, txIdFromDataItem } from "@ar.io/anchor";
import {
  bytesToHex,
  ed25519Verify,
  hexToBytes,
  utf8,
  verifyEnvelope,
  verifyInclusion,
} from "@ar.io/proof";
import { describe, expect, it } from "vitest";

import type { AuditRecord } from "@intx/types/audit";
import type { AuditStore, CryptoProvider } from "@intx/types/runtime";

import { anchoredAuditStore, signerFromCryptoProvider } from "../src/index";

// The raw-sign half of Interchange's CryptoProvider: raw 64-byte Ed25519
// sign, raw 32-byte public key, synchronous getPublicKey() — the exact
// surface signerFromCryptoProvider needs, backed here by the SDK's local
// signer.
async function fakeCryptoProvider(): Promise<Pick<CryptoProvider, "sign" | "getPublicKey">> {
  const key = LocalEd25519Signer.fromSeedHex("ab".repeat(32));
  const publicKey = await key.publicKey();
  return {
    sign: (content: Uint8Array) => key.sign(content),
    getPublicKey: () => publicKey,
  };
}

// Honest stub: the txId is what the bytes derive (mirrors the anchor
// package's own seam-4 stub). No network.
function stubUploader() {
  return {
    async upload(dataItem: Uint8Array) {
      return { txId: await txIdFromDataItem(dataItem), raw: {} };
    },
  };
}

function noopInner(): AuditStore {
  return {
    commitAudit: async () => {},
    loadAudit: async () => [],
    commitErrors: async () => {},
  };
}

function auditRecord(over: Partial<AuditRecord>): AuditRecord {
  return {
    callId: "call-1",
    tool: "fs_read",
    arguments: { path: "/etc/hosts" },
    authz: { effect: "allow", resolvedBy: null, matchingGrants: [], blocked: false },
    result: { content: "ok", isError: false },
    timestamp: "2026-07-08T00:00:00Z",
    sessionId: "sess-e2e",
    seq: 0,
    ...over,
  };
}

describe("signerFromCryptoProvider", () => {
  it("round-trips: sign via the provider, verify via @ar.io/proof", async () => {
    const provider = await fakeCryptoProvider();
    const signer = signerFromCryptoProvider(provider);

    const message = utf8("anchored through the agent's own identity key");
    const signature = await signer.sign(message);
    const publicKey = await signer.publicKey();

    expect(signature).toHaveLength(64);
    expect(publicKey).toEqual(provider.getPublicKey());
    expect(await ed25519Verify(bytesToHex(signature), message, bytesToHex(publicKey))).toBe(true);
  });
});

describe("end-to-end: anchor Interchange records, verify with @ar.io/proof", () => {
  async function anchorASession() {
    const provider = await fakeCryptoProvider();
    const anchorer = createAnchorer({
      signer: signerFromCryptoProvider(provider),
      uploader: stubUploader(),
      warn: () => {},
    });
    const store = anchoredAuditStore(noopInner(), anchorer);

    await store.commitAudit([
      auditRecord({ callId: "c0", seq: 0 }),
      auditRecord({
        callId: "c1",
        seq: 1,
        tool: "shell_exec",
        authz: { effect: "deny", resolvedBy: null, matchingGrants: [], blocked: true, blockReason: "policy" },
        result: { content: "", isError: true },
      }),
    ]);
    const bySession = await store.close();
    return { provider, anchorer, receipts: bySession.get("sess-e2e")! };
  }

  it("every record verifies green — signature, payload binding, Merkle inclusion", async () => {
    const { provider, receipts } = await anchorASession();
    expect(receipts).toHaveLength(2);

    for (const r of receipts) {
      const result = await verifyEnvelope(r.envelope, { payloadBytes: r.recordBytes });
      expect(result.ok).toBe(true);
      expect(result.signatureOk).toBe(true);
      expect(result.payloadHashOk).toBe(true);
      expect(result.errors).toEqual([]);

      // Signed with the agent's OWN identity key, not a second anchoring key.
      expect(r.envelope.public_key).toBe(bytesToHex(provider.getPublicKey()));

      const included = await verifyInclusion(
        hexToBytes(r.leafHash),
        r.leafIndex,
        r.leafCount,
        r.auditPath.map(hexToBytes),
        hexToBytes(r.root),
      );
      expect(included).toBe(true);
    }
  });

  it("the committed record carries the event type and the session chain", async () => {
    const { receipts } = await anchorASession();

    const records = receipts.map(
      (r) => JSON.parse(new TextDecoder().decode(r.recordBytes)) as {
        event_type: string;
        metadata: { interchange: Record<string, unknown> };
      },
    );
    expect(records.map((r) => r.event_type)).toEqual([
      "interchange.tool_call",
      "interchange.tool_blocked",
    ]);
    expect(records[0]!.metadata.interchange).toMatchObject({
      session_id: "sess-e2e",
      call_id: "c0",
      prev_event_id: null,
    });
    expect(records[1]!.metadata.interchange.prev_event_id).toBe(receipts[0]!.eventId);
  });

  it("receipts feed anchorer.bundle() for the one-file auditor handoff", async () => {
    const { anchorer, receipts } = await anchorASession();
    const bundle = await anchorer.bundle(receipts);
    expect(bundle.body.events).toHaveLength(2);
    expect(bundle.body.checkpoints.length).toBeGreaterThanOrEqual(1);
  });
});
