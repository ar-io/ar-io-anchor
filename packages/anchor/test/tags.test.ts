import { sha256Hex, utf8 } from "@ar.io/proof";
import { describe, expect, it } from "vitest";

import { buildTags } from "../src/tags";

describe("buildTags (profile §7, Minimal-constrained)", () => {
  it("emits exactly the four base tags by default — nothing semantic", async () => {
    const tags = await buildTags({ environment: "dev" });
    expect(tags).toEqual([
      { name: "Content-Type", value: "application/json" },
      { name: "App-Name", value: "ario-anchor" },
      { name: "App-Version", value: "ario.events/v1" },
      { name: "Environment", value: "dev" },
    ]);
    const names = tags.map((t) => t.name);
    for (const leaky of ["Event-Type", "Tenant-Id", "Agent-Id", "Public-Key", "Content-Hash"]) {
      expect(names).not.toContain(leaky);
    }
  });

  it("hashes the scope namespace — the raw namespace never appears", async () => {
    const tags = await buildTags({ environment: "production", scopeNamespace: "acme/orders" });
    const scope = tags.find((t) => t.name === "Scope");
    expect(scope?.value).toBe(await sha256Hex(utf8("acme/orders")));
    expect(tags.some((t) => t.value.includes("acme"))).toBe(false);
  });

  it("includes Content-Hash only on explicit opt-in, validated", async () => {
    const hash = "a".repeat(64);
    const tags = await buildTags({ environment: "dev", contentHash: hash });
    expect(tags.find((t) => t.name === "Content-Hash")?.value).toBe(hash);
    await expect(buildTags({ environment: "dev", contentHash: "ZZ" })).rejects.toThrow(
      /sha256/,
    );
  });

  it("rejects an empty scope namespace", async () => {
    await expect(buildTags({ environment: "dev", scopeNamespace: "" })).rejects.toThrow(
      /non-empty/,
    );
  });
});
