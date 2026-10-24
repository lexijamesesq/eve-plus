import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Shipped code may import only eve's public package exports, so an eve release that keeps
// those exports can't break it. eve's `internal/*` subpaths are exported but not public.
// Test files are exempt: the state round-trip test reaches eve's internal state resolution.
const eveManifest = JSON.parse(
  readFileSync(new URL("../node_modules/eve/package.json", import.meta.url), "utf8"),
) as { exports: Record<string, unknown> };
const publicSpecifiers = new Set(
  Object.keys(eveManifest.exports)
    .filter((subpath) => !subpath.startsWith("./internal/"))
    .map((subpath) => (subpath === "." ? "eve" : `eve${subpath.slice(1)}`)),
);

const srcDir = new URL("./", import.meta.url);
const shipped = readdirSync(srcDir).filter(
  (file) => file.endsWith(".ts") && !file.endsWith(".test.ts"),
);

function eveSpecifiers(source: string): string[] {
  const pattern =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["'](eve(?:\/[^"']*)?)["']/g;
  return [...source.matchAll(pattern)].map((match) => match[1] as string);
}

describe("shipped src/ imports only eve's public exports", () => {
  it("finds shipped files to check", () => {
    expect(shipped).toContain("index.ts");
  });

  for (const file of shipped) {
    it(file, () => {
      const source = readFileSync(new URL(file, srcDir), "utf8");
      const offending = eveSpecifiers(source).filter(
        (specifier) => !publicSpecifiers.has(specifier),
      );
      expect(offending).toEqual([]);
    });
  }
});

describe("the specifier scan", () => {
  it("catches static, side-effect, dynamic and require forms", () => {
    const source = [
      `import { a } from "eve/sandbox/provider";`,
      `import "eve/internal/mount-state";`,
      `const b = await import("eve/dist/src/sandbox/state.js");`,
      `const c = require('eve');`,
      `export * from "eve/sandbox";`,
      `import { d } from "evelyn";`,
    ].join("\n");
    expect(eveSpecifiers(source)).toEqual([
      "eve/sandbox/provider",
      "eve/internal/mount-state",
      "eve/dist/src/sandbox/state.js",
      "eve",
      "eve/sandbox",
    ]);
  });

  it("treats a deep path and an internal subpath as non-public", () => {
    expect(publicSpecifiers.has("eve/sandbox/provider")).toBe(true);
    expect(publicSpecifiers.has("eve/internal/mount-state")).toBe(false);
    expect(publicSpecifiers.has("eve/dist/src/sandbox/state.js")).toBe(false);
  });
});
