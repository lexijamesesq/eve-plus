import { defineConfig } from "vitest/config";

/**
 * Integration tests: on-disk stores (restart, migrations) and the provider driven through eve's memory contract.
 * Each test works in its own temporary directory.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/*.integration.test.ts"],
    exclude: ["**/node_modules/**"],
    testTimeout: 30_000,
  },
});
