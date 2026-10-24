import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveNetworkPolicy, UnsupportedNetworkPolicyError } from "./network-policy.js";

// The README's policy table is the published contract, so the test reads it rather than
// restating it: a row added there is a row tested here.
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const section = readme.split("## Network policy")[1]?.split("\n## ")[0] ?? "";
const rows = section
  .split("\n")
  .filter((line) => line.startsWith("|"))
  .map((line) =>
    line
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim()),
  )
  .filter(([shape]) => shape !== "Shape" && !/^-+$/.test(shape ?? ""));

describe("the README's network policy table", () => {
  it("lists the accepted and rejected shapes", () => {
    expect(rows.length).toBeGreaterThanOrEqual(10);
  });

  for (const [shape, result] of rows) {
    it(`${shape} → ${result}`, () => {
      const policy = shape === "absent" ? undefined : JSON.parse(shape.replace(/^`|`$/g, ""));
      if (result === "rejects") {
        expect(() => resolveNetworkPolicy(policy)).toThrow(UnsupportedNetworkPolicyError);
      } else {
        expect(resolveNetworkPolicy(policy)).toBe(result.replace(/`/g, ""));
      }
    });
  }
});

describe("resolveNetworkPolicy", () => {
  it("defaults to deny-all when no policy is given", () => {
    expect(resolveNetworkPolicy(undefined)).toBe("deny-all");
  });

  it("names the rejected policy in the error", () => {
    expect(() => resolveNetworkPolicy({ allow: ["*"] })).toThrow(/\{"allow":\["\*"\]\}/);
  });
});
