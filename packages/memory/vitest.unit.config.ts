import { defineConfig } from "vitest/config";

/**
 * Unit tests: the core adapter on an in-memory store. No filesystem, subprocesses, or network.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/*.test.ts"],
    exclude: ["**/node_modules/**", "src/*.integration.test.ts"],
    testTimeout: 5_000,
  },
});
