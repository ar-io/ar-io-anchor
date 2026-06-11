import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // @ar.io/proof@0.1.1's published dist uses extension-less relative ESM
    // imports, which Node's loader rejects (bundler-resolution artifact).
    // Inline it so Vite resolves the package instead of Node. Reported to the
    // kernel maintainer; drop this when a fixed version publishes.
    server: {
      deps: {
        inline: ["@ar.io/proof"],
      },
    },
  },
});
