import { describe, expect, it } from "vitest";

import { PROFILE_SPEC_VERSION } from "../src/index";

describe("profile constants", () => {
  it("pins the ario.events/v1 spec_version string", () => {
    expect(PROFILE_SPEC_VERSION).toBe("ario.events/v1");
  });

  it("conforms to the envelope-spec §2 spec_version grammar", () => {
    // <namespace>/v<major>[.<minor>], major and minor numeric.
    expect(PROFILE_SPEC_VERSION).toMatch(/^[a-z][a-z0-9.]*\/v[0-9]+(\.[0-9]+)?$/);
  });
});
