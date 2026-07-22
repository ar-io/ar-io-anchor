// Runtime-schema gate against the real @intx/types. The adapter is typed
// directly against @intx/types (peerDependency), so static drift is caught
// by tsc at the import sites. What tsc CANNOT catch is upstream tightening
// of the runtime arktype schemas beyond what the static types say (a
// narrowed enum refinement, a new bounds check). This file keeps the
// canonical fixtures our behavioral tests anchor validating against
// Interchange's OWN runtime schemas, so a tightened @intx/types bump fails
// HERE — not in a consumer's audit trail.

import {
  AuditRecord as AuditRecordSchema,
  ErrorRecord as ErrorRecordSchema,
} from "@intx/types/audit";
import { type } from "arktype";
import { describe, expect, it } from "vitest";

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
