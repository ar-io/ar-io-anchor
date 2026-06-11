// On-chain Arweave tags for ario.events/v1 (profile §7). Tags are search
// hints OUTSIDE the signed scope — never trusted, always re-verified — and
// Minimal disclosure constrains them hard: no event type, no subject
// identity, and no content hash unless the caller explicitly opts in.

import { sha256Hex, utf8 } from "@ar.io/proof";

import type { Tag } from "./avro";
import { PROFILE_SPEC_VERSION } from "./profile";
import type { Environment } from "./types";

export interface TagOptions {
  environment: Environment;
  // Opaque scope tag (§5.1 enumeration key): pass the caller's namespace
  // string; only its SHA-256 goes on-chain. Rotation-capable by design.
  scopeNamespace?: string;
  // DISCLOSURE — opt-in only: publishes the content hash linkage on-chain to
  // enable reverse provenance lookup (artifact → proof).
  contentHash?: string;
}

export async function buildTags(opts: TagOptions): Promise<Tag[]> {
  const tags: Tag[] = [
    { name: "Content-Type", value: "application/json" },
    { name: "App-Name", value: "ario-anchor" },
    { name: "App-Version", value: PROFILE_SPEC_VERSION },
    { name: "Environment", value: opts.environment },
  ];
  if (opts.scopeNamespace !== undefined) {
    if (opts.scopeNamespace.length === 0) {
      throw new Error("scopeNamespace must be non-empty");
    }
    tags.push({ name: "Scope", value: await sha256Hex(utf8(opts.scopeNamespace)) });
  }
  if (opts.contentHash !== undefined) {
    if (!/^[0-9a-f]{64}$/.test(opts.contentHash)) {
      throw new Error("contentHash tag must be lowercase sha256 hex");
    }
    tags.push({ name: "Content-Hash", value: opts.contentHash });
  }
  return tags;
}
