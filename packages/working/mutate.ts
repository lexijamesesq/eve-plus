// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the find/replace strings below contain literal ${...} fragments to match in source, not template placeholders
// Mutation check for the test suite: re-introduce each guarded bug in a scratch copy of the sources and require the
// test that guards it to fail. A guard that stays green on its own bug is decoration. Zero quota.
//   node mutate.ts

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";

interface Mutation {
  name: string;
  file: "src/provider.ts" | "src/render.ts" | "src/store.ts";
  find: string | RegExp;
  replace: string;
  /** Part of the title of the test that must fail. */
  expect: string;
}
interface Report {
  numTotalTests: number;
  testResults: { assertionResults: { title: string; status: string }[] }[];
}

const here = new URL(".", import.meta.url).pathname;
// A scratch directory per invocation, inside the package so the copies resolve its node_modules.
mkdirSync(`${here}.mut`, { recursive: true });
const scratch = `${mkdtempSync(`${here}.mut/run-`)}/`;
const files = [
  "src/addresses.ts",
  "src/index.ts",
  "src/provider.ts",
  "src/render.ts",
  "src/store.ts",
  "src/stats.ts",
  "src/stats-cli.ts",
  "tsconfig.build.json",
  "vitest.unit.config.ts",
  "vitest.integration.config.ts",
  "src/render.test.ts",
  "src/store.test.ts",
  "src/store.integration.test.ts",
  "src/provider.integration.test.ts",
  "src/stats.integration.test.ts",
];
const vitest = `${here}node_modules/vitest/vitest.mjs`;

const mutations: Mutation[] = [
  // Recall never throws: on any failure it answers both blocks as an outage.
  {
    name: "recall rethrows a store failure",
    file: "src/provider.ts",
    find: "console.warn(`[working] turn-start recall failed: ${reason}`);",
    replace: "throw error;",
    expect: "never throws on a corrupt store file",
  },
  {
    name: "the host's resolver runs outside the guard",
    file: "src/provider.ts",
    find: /try \{\n(\s*)const auth = context\.session\?\.auth\?\.current \?\? null;\n\s*const address = addressOf\(auth\);/,
    replace:
      "const auth = context.session?.auth?.current ?? null;\n    const address = addressOf(auth);\n    try {",
    expect: "never throws when the host's resolver does",
  },
  {
    name: "a failed open is kept, so an outage is sticky",
    file: "src/provider.ts",
    find: /let store: WorkingStore \| undefined;\n(\s*)const get = \(\): WorkingStore => \{\n\s*if \(store\) return store;/,
    replace:
      'let store: WorkingStore | undefined;\n  let failed: unknown;\n  const get = (): WorkingStore => {\n    if (store) return store;\n    if (failed) throw failed;\n    failed = new Error("the store failed to open earlier");',
    expect: "recovers on the next turn once the store opens",
  },
  {
    name: "the outage note falls silent",
    file: "src/provider.ts",
    find: "const outage = renderOutage(reason);",
    replace: 'const outage = { here: "", standing: "" };',
    expect: "never throws on a corrupt store file",
  },

  // Recall is never empty, and keeps its two stable ids.
  {
    name: "nothing stored recalls nothing",
    file: "src/provider.ts",
    find: "const view = {",
    replace:
      "if ((here?.totals.loops ?? 0) + orders.totals.orders + elsewhere.totals.loops === 0) return null;\n      const view = {",
    expect: "recall returns exactly the two stable ids, every turn, even with nothing stored",
  },
  {
    name: "an empty conversation says nothing",
    file: "src/render.ts",
    find: 'empty: "Nothing open in this conversation.",',
    replace: "",
    expect: "are never empty: nothing open is said, with the time",
  },
  {
    name: "nothing elsewhere says nothing",
    file: "src/render.ts",
    find: 'empty: "Nothing else open.",',
    replace: "",
    expect: "are never empty: nothing open is said, with the time",
  },
  {
    name: "the here block loses its stable id",
    file: "src/provider.ts",
    find: "{ id: HERE_ID, content: renderHere(view) },",
    replace: "{ content: renderHere(view) },",
    expect: "recall returns exactly the two stable ids, every turn, even with nothing stored",
  },
  {
    name: "the budget is ignored",
    file: "src/render.ts",
    find: "if (length + line.length + 1 > max - reserve) {",
    replace: "if (false) {",
    expect: "past the budget, shows counts and points to the list tool",
  },

  // A claim is atomic: each due loop is claimed once.
  {
    name: "a live lease doesn't hold a loop",
    file: "src/store.ts",
    find: "AND (status = 'open' OR (status = 'delivering' AND lease_until <= ?))",
    replace: "AND status IN ('open', 'delivering') AND ? IS NOT NULL",
    expect: "claimDue claims a due loop once",
  },
  {
    name: "concurrent ticks double-claim under a live lease",
    file: "src/store.ts",
    find: "AND (status = 'open' OR (status = 'delivering' AND lease_until <= ?))",
    replace: "AND status IN ('open', 'delivering') AND ? IS NOT NULL",
    expect: "claimDue claims each row once under concurrent ticks",
  },
  {
    name: "a claim reads, then writes, outside one statement and transaction",
    file: "src/store.ts",
    find: /return this\.#tx\(\(\) => \{\n\s*const rows = this\.#db\n\s*\.prepare\(\n\s*`UPDATE loops SET status = 'delivering'[\s\S]*?as Row\[\];/,
    replace:
      "return ((f: () => ClaimedLoop[]) => f())(() => {\n      const due = this.#db.prepare(\"SELECT id FROM loops WHERE wake = 'pending' AND due_at IS NOT NULL AND due_at <= ? AND (status = 'open' OR (status = 'delivering' AND lease_until <= ?))\").all(now, now) as Row[];\n      const rows: Row[] = [];\n      for (const d of due) {\n        const r = this.#db.prepare(\"UPDATE loops SET status = 'delivering', lease_until = ?, lease_token = ? WHERE id = ? RETURNING *\").get(now + leaseMs, token, d.id) as Row | undefined;\n        if (r) rows.push(r);\n      }",
    expect: "claimDue claims each row once under concurrent ticks",
  },
  {
    name: "settling ignores the lease token",
    file: "src/store.ts",
    find: 'before?.status !== "delivering" || before.lease_token !== token',
    replace: 'before?.status !== "delivering"',
    expect: "claimDue claims a due loop once; settling reopens it",
  },

  // The other contracts the Done When names.
  {
    name: "a re-run imports follow-ups again",
    file: "src/store.ts",
    find: 'if (this.#db.prepare("SELECT 1 FROM loops WHERE followup_id = ?").get(followupId)) {',
    replace: "if (false) {",
    expect: "imports a follow-ups file once",
  },
  {
    name: "an order change isn't logged",
    file: "src/store.ts",
    find: "orderChanges++;",
    replace: "",
    expect: "an operator's order lifted or replaced from another origin logs one order-change line",
  },
  {
    name: "every order change is logged, not only an operator's from elsewhere",
    file: "src/store.ts",
    find: 'if (set.kind !== "operator" || origin.kind === "operator") return;',
    replace: "",
    expect: "an operator's order lifted or replaced from another origin logs one order-change line",
  },
  {
    name: "a redelivered old event wakes a newer loop",
    file: "src/store.ts",
    find: "AND wake_set_at <= ?",
    replace: "AND ? IS NOT NULL",
    expect: "an event wakes loops whose wake was set by then",
  },
  {
    name: "the address comes from the model",
    file: "src/provider.ts",
    find: ".strict(),\n  },\n  update: {",
    replace: ".passthrough(),\n  },\n  update: {",
    expect: "identity and address come from the session, never from arguments",
  },
];

function anchor(find: string | RegExp): RegExp {
  if (find instanceof RegExp) return find;
  let re = "";
  for (const token of find.trim().match(/\s+|[^\s]/g) ?? []) {
    if (/^\s/.test(token)) re += "\\s*";
    else if (token === "'" || token === '"') re += `['"]`;
    else if ("([{".includes(token)) re += `\\${token}\\s*`;
    else if (")]}".includes(token)) re += `,?\\s*\\${token}`;
    else if (token === ",") re += ",\\s*";
    else re += token.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  }
  return new RegExp(re);
}

// Every tier's results for the suite in one scratch copy: title → passed. null when a suite could not load.
function runSuite(dir: string): Map<string, boolean> | null {
  const titles = new Map<string, boolean>();
  for (const config of ["vitest.unit.config.ts", "vitest.integration.config.ts"]) {
    const out = `${dir + config}.json`;
    spawnSync(
      process.execPath,
      [vitest, "run", "--config", config, "--reporter=json", "--outputFile", out],
      { cwd: dir, encoding: "utf8" },
    );
    if (!existsSync(out)) return null;
    const report = JSON.parse(readFileSync(out, "utf8")) as Report;
    const results = report.testResults.flatMap((r) => r.assertionResults);
    // A suite that fails to load reports its file with no tests in it.
    if (report.testResults.some((r) => r.assertionResults.length === 0)) return null;
    for (const t of results) titles.set(t.title, t.status === "passed");
  }
  return titles;
}

function scratchCopy(): string {
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(`${scratch}src`, { recursive: true });
  for (const f of files) cpSync(here + f, scratch + f);
  // The concurrency test compiles the store from the copy, against the package's own dependencies.
  cpSync(`${here}package.json`, `${scratch}package.json`);
  return scratch;
}

// Baseline: the unmutated suite passes, and every guard a mutation names is a real test.
const baseline = runSuite(scratchCopy());
if (!baseline || [...baseline.values()].some((passed) => !passed)) {
  console.log("❌ the unmutated suite does not pass; fix it before checking mutations");
  process.exit(1);
}
const unknown = mutations.filter((m) => ![...baseline.keys()].some((t) => t.includes(m.expect)));
for (const m of unknown) console.log(`  UNKNOWN   ${m.name} — no test titled "${m.expect}"`);

let survived = unknown.length;
for (const m of mutations) {
  if (unknown.includes(m)) continue;
  const dir = scratchCopy();
  const src = readFileSync(dir + m.file, "utf8");
  const mutated = src.replace(anchor(m.find), () => m.replace);
  if (mutated === src) {
    console.log(`  STALE     ${m.name} — anchor not found in ${m.file}`);
    survived++;
    continue;
  }
  writeFileSync(dir + m.file, mutated);
  const results = runSuite(dir);
  const killed =
    results !== null && [...results].some(([t, passed]) => !passed && t.includes(m.expect));
  if (!killed) survived++;
  console.log(
    `  ${killed ? "KILLED  " : results ? "SURVIVED" : "BROKEN  "}  ${m.name}${results ? "" : " — the mutant did not load (fix the mutation)"}`,
  );
}
rmSync(scratch, { recursive: true, force: true });
console.log(
  `\n${survived === 0 ? "✅ every guard bites" : `❌ ${survived} mutation(s) survived`}: ${mutations.length - survived}/${mutations.length} killed`,
);
process.exit(survived === 0 ? 0 : 1);
