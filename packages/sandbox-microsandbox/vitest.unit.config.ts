import { defineConfig } from "vitest/config";

/**
 * Unit tests: pure logic, no VM. The real-VM proof runs by hand on a KVM host (see the README).
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/*.test.ts"],
    exclude: ["**/node_modules/**"],
    testTimeout: 5_000,
  },
});
