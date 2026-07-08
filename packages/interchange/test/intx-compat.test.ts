// Drift gate against the real @intx/types (devDependency ONLY — consumers
// never see it; the published adapter keeps zero Interchange dependencies).
//
// Our src/index.ts interfaces are structural mirrors of Interchange's
// shapes, verified against source at authoring time. This file keeps that
// verification alive: if a devDependency bump brings an @intx/types whose
// shapes no longer line up with the mirrors, `npm run typecheck` fails here
// — at the exact API boundary that would break — instead of drifting
// silently. (The hazard is real: the shape this adapter was originally
// specified against had already drifted from Interchange source.)

import type { Anchorer, Signer } from "@ar.io/anchor";
import {
  AuditRecord as AuditRecordSchema,
  ErrorRecord as ErrorRecordSchema,
  type AuditRecord,
  type ErrorRecord,
} from "@intx/types/audit";
import type { AuditStore, CryptoProvider } from "@intx/types/runtime";
import { type } from "arktype";
import { describe, expect, it } from "vitest";

import {
  anchoredAuditStore,
  anchorRecordsFromCollector,
  signerFromCryptoProvider,
} from "../src/index";

// Compile-time gate. Never called — its body is every boundary a real
// Interchange host crosses, typed with Interchange's OWN types:
//   inbound: their store decorates, their records/errors anchor, their
//            CryptoProvider adapts to a Signer;
//   outbound: the decorated store hands back to Interchange wherever an
//            AuditStore goes.
// If any line stops typechecking after an @intx/types bump, a mirror in
// src/index.ts needs updating (and possibly the runtime code behind it).
export function intxTypesStillFitOurMirrors(
  theirStore: AuditStore,
  theirRecords: AuditRecord[],
  theirErrors: ErrorRecord[],
  theirProvider: CryptoProvider,
  anchorer: Anchorer,
): AuditStore {
  const store = anchoredAuditStore(theirStore, anchorer);
  void store.commitAudit(theirRecords);
  void store.commitErrors(theirErrors);
  void store.loadAudit("session");
  anchorRecordsFromCollector(store, theirRecords);
  const signer: Signer = signerFromCryptoProvider(theirProvider);
  void signer;
  return store;
}

// Runtime half of the gate: the canonical fixtures our behavioral tests
// anchor must validate against Interchange's own arktype schemas — so a
// tightened upstream schema (new required field, narrowed enum) fails HERE,
// not in a consumer's audit trail.
describe("fixtures validate against Interchange's own schemas", () => {
  it("an audit record fixture is a valid @intx/types AuditRecord", () => {
    const fixture = {
      callId: "call-1",
      tool: "fs_read",
      arguments: { path: "/etc/hosts" },
      authz: {
        effect: "allow",
        resolvedBy: null,
        matchingGrants: [],
        blocked: false,
      },
      result: { content: "127.0.0.1 localhost", isError: false },
      timestamp: "2026-07-08T00:00:00Z",
      sessionId: "sess-a",
      seq: 0,
    };
    const validated = AuditRecordSchema(fixture);
    expect(validated instanceof type.errors ? validated.summary : "ok").toBe("ok");
  });

  it("an error record fixture is a valid @intx/types ErrorRecord", () => {
    const fixture = {
      source: "inference",
      category: "rate_limit",
      message: "429 from provider",
      fatal: false,
      timestamp: "2026-07-08T00:00:01Z",
      sessionId: "sess-a",
      seq: 1,
    };
    const validated = ErrorRecordSchema(fixture);
    expect(validated instanceof type.errors ? validated.summary : "ok").toBe("ok");
  });
});
