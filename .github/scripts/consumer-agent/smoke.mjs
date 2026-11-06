// smoke.mjs
//
// Run in the consumer project after install: each package's public API imports by name from the installed package,
// and the native stores open and take a write in a temporary directory, so a binding that doesn't load (better-sqlite3
// for memory, node:sqlite for working) fails here rather than in a running agent.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import commissioning from "@eve-plus/commissioning";
import { cyrus } from "@eve-plus/commissioning/cyrus";
import { MemoryGraph, shaclMemory } from "@eve-plus/memory";
import { MicrosandboxSandbox } from "@eve-plus/sandbox-microsandbox";
import { workingMemory } from "@eve-plus/working";
import { openWorkingStore } from "@eve-plus/working/store";

const problems = [];
const expect = (ok, what) => ok || problems.push(what);
const dir = mkdtempSync(join(tmpdir(), "consumer-"));

expect(typeof commissioning === "function", "commissioning's default export is not a function");
expect(typeof cyrus === "function", "commissioning/cyrus's cyrus is not a function");
expect(typeof shaclMemory === "function", "memory's shaclMemory is not a function");
expect(typeof workingMemory === "function", "working's workingMemory is not a function");
expect(
  typeof MicrosandboxSandbox?.environment === "function",
  "sandbox-microsandbox's MicrosandboxSandbox has no environment()",
);

const graph = await MemoryGraph.create({ dir: join(dir, "memory") });
const saved = await graph.remember({ type: "Thing", label: "Consumer Probe" });
expect(saved.ok, `memory refused a write: ${JSON.stringify(saved)}`);
expect(
  graph.resolve("knowledge:consumer-probe").status === "found",
  "memory's write doesn't resolve by its handle",
);
graph.close();

const store = openWorkingStore({ dir: join(dir, "working") });
const opened = store.open(
  {
    address: { kind: "named", name: "consumer" },
    principal: null,
    what: "Probe the consumer",
    waitingOn: "nothing",
    next: "close it",
  },
  { principalId: null, kind: "other", sessionId: null },
);
expect(opened.ok, `working refused a write: ${JSON.stringify(opened)}`);
store.close();

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
