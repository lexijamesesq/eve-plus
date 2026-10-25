import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveNetworkPolicy, UnsupportedNetworkPolicyError } from "./network-policy.js";

// The README's policy table is the published contract. Every shape it accepts is tested from the table, so an
// accepted row added there is tested here. Every rejection fails at the same check, so three representatives from
// the table stand for the rest: an object, a wrong-case string, and null.
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
const parse = (shape: string) =>
  shape === "absent" ? undefined : JSON.parse(shape.replace(/^`|`$/g, ""));

describe("the README's network policy table", () => {
  for (const [shape, result] of rows.filter(([, result]) => result !== "rejects")) {
    it(`${shape} → ${result}`, () => {
      expect(resolveNetworkPolicy(parse(shape))).toBe(result.replace(/`/g, ""));
    });
  }

  for (const shape of ["`{}`", '`"DENY-ALL"`', "`null`"]) {
    it(`${shape} → rejects`, () => {
      expect(rows).toContainEqual([shape, "rejects"]);
      expect(() => resolveNetworkPolicy(parse(shape))).toThrow(UnsupportedNetworkPolicyError);
    });
  }
});

describe("resolveNetworkPolicy", () => {
  it("names the rejected policy in the error", () => {
    expect(() => resolveNetworkPolicy({ allow: ["*"] })).toThrow(/\{"allow":\["\*"\]\}/);
  });
});
