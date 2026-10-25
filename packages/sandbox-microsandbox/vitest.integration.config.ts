import { defineConfig } from "vitest/config";

/**
 * The real-VM proof: a KVM host, a live network, and the installed package. It runs inside run.sh's throwaway
 * container, never through `npm test`. Its probes build on each other, so they run in order in one file.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["integration/*.integration.test.mjs"],
    exclude: ["**/node_modules/**"],
    testTimeout: 300_000,
  },
});
