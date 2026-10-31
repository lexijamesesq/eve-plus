import { defineConfig } from "vitest/config";

/**
 * The real-VM proof: a KVM host, a live network, and the installed package. integration/proof.sh runs it inside a
 * throwaway container, never through `npm test`. Its probes build on each other, so they run in order in one file.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["integration/*.integration.test.mjs"],
    exclude: ["**/node_modules/**"],
    testTimeout: 300_000,
  },
});
