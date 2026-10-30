// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the find/replace strings below contain literal ${...} SQL fragments to match in source, not template placeholders
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
  file: "src/memory-graph.ts" | "src/provider.ts" | "src/stats.ts";
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
// A scratch directory per invocation, inside the package so the copies resolve its node_modules. Runs used to share
// one fixed path, and two concurrent runs deleted each other's copies and reported each other's counts.
mkdirSync(`${here}.mut`, { recursive: true });
const scratch = `${mkdtempSync(`${here}.mut/run-`)}/`;
const files = [
  "src/provider.ts",
  "src/memory-graph.ts",
  "src/stats.ts",
  "src/shacl-shacl.data.ts",
  "vitest.unit.config.ts",
  "vitest.integration.config.ts",
  "src/memory-graph.test.ts",
  "src/memory-graph.integration.test.ts",
  "src/provider.integration.test.ts",
  "src/stats.integration.test.ts",
];
const vitest = `${here}node_modules/vitest/vitest.mjs`;

const mutations: Mutation[] = [
  {
    name: "recall as one whole-string phrase",
    file: "src/memory-graph.ts",
    find: /const ftsQuery = \(s: string\) => \{[\s\S]*?\n\}/,
    replace: "const ftsQuery = (s: string) => JSON.stringify(String(s))",
    expect: "multi-word recall matches out-of-order tokens",
  },
  {
    name: "turn-start recall reads history, not the new delivery",
    file: "src/provider.ts",
    find: "latestUserText(turnInput ?? context.messages)",
    replace: "latestUserText(context.messages)",
    expect: "turn-start recall reads turn.input",
  },
  {
    name: "attributes are write-only",
    file: "src/memory-graph.ts",
    find: "attributes[key] = r.o;",
    replace: "",
    expect: "recall returns stored attributes",
  },
  {
    name: "rules invisible at turn start",
    file: "src/provider.ts",
    find: "const rules = mg.shapeIndex();",
    replace: "const rules = [];",
    expect: "turn-start injects active rules",
  },
  {
    name: "extend_schema hides its targeting scope",
    file: "src/provider.ts",
    find: "It applies ONLY to things saved with type",
    replace: "It applies to things of type",
    expect: "extend_schema teaches its targeting scope",
  },
  {
    name: "a type-dodging save passes silently",
    file: "src/memory-graph.ts",
    find: "const skipped = this.#shapeIndex.filter((r) => r.class !== view.type)",
    replace: "const skipped: ShapeEntry[] = []",
    expect: "remember under another type names the rule",
  },
  // Supersession: the store is an attributed append log and reads serve the current value.
  {
    name: "identical re-save appends (not idempotent against the current value)",
    file: "src/memory-graph.ts",
    find: "const changes = want.filter(",
    replace: "const changes = want; void want.filter(",
    expect: "re-saving an identical fact adds no triples",
  },
  {
    name: "first write wins on read (stale value served)",
    file: "src/memory-graph.ts",
    find: "const LATEST_SINGLE = `seq = (SELECT max(seq) FROM triples WHERE s=t.s AND p=t.p AND ${SINGLE_VALUED})`",
    replace:
      "const LATEST_SINGLE = `seq = (SELECT min(seq) FROM triples WHERE s=t.s AND p=t.p AND ${SINGLE_VALUED})`",
    expect: "an update wins on read",
  },
  {
    name: "superseded values stay searchable",
    file: "src/memory-graph.ts",
    find: "    this.#delF.run(s)\n",
    replace: "",
    expect: "a superseded value is no longer findable by search",
  },
  {
    name: "lint checks only the write, not the resulting entity",
    file: "src/memory-graph.ts",
    find: "PREFIXES + toTtl(after)",
    replace: "PREFIXES + toTtl([...want, ...relations])",
    expect: "a heal that supplies only the missing detail is accepted",
  },
  {
    name: "writes are unattributed",
    file: "src/memory-graph.ts",
    find: "at, origin)",
    replace: "at, DIRECT)",
    expect: "every write is attributed",
  },
  {
    name: "revert leaves the search index on the reverted values",
    file: "src/memory-graph.ts",
    find: "      for (const s of affected) this.#reindex(s)\n",
    replace: "",
    expect: "reverting one attributed batch falls back",
  },
  {
    name: "supersession is silent",
    file: "src/memory-graph.ts",
    find: "if (superseded.length) summary +=",
    replace: "if (false) summary +=",
    expect: "remember says what it replaced",
  },
  {
    name: "migration does not attribute legacy rows",
    file: "src/memory-graph.ts",
    find: "WHERE origin IS NULL;",
    replace: "WHERE 0;",
    expect: "v1→v2 migration self-heals a stale duplicate",
  },
  {
    name: "re-asserting an older value is swallowed as a duplicate",
    file: "src/memory-graph.ts",
    find: "return !c || c.o !== w.o",
    replace: "return !this.history(id).some((h) => h.value === w.o) && (!c || c.o !== w.o)",
    expect: "re-asserting an older value appends and becomes current",
  },
  // Forget: tombstones in the append log, excluded from the current view, attributed and revertible.
  {
    name: "tombstones leak into the current view",
    file: "src/memory-graph.ts",
    find: " AND ot != 'tomb'`)",
    replace: "`)",
    expect: "a forgotten thing has no current state",
  },
  {
    name: "forget leaves the thing searchable",
    file: "src/memory-graph.ts",
    find: "this.#reindex(s);\n    })();\n    const forgotten",
    replace: "})();\n    const forgotten",
    expect: "forgetting a whole thing removes it from recall",
  },
  {
    name: "forget hard-deletes (no history, no revert)",
    file: "src/memory-graph.ts",
    find: "for (const r of rows) this.#ins(s, r.p, isRelation(r.p, r.ot) ? r.o : '', isRelation(r.p, r.ot) ? 'tomb-edge' : 'tomb', null, at, origin)",
    replace:
      "for (const r of rows) this.db.prepare('DELETE FROM triples WHERE s=? AND p=?').run(s, r.p)",
    expect: "a forgotten thing has no current state, but what was forgotten stays in history",
  },
  {
    name: "forget is silent about breaking a record type",
    file: "src/memory-graph.ts",
    find: "if (!report.conforms) breaks = this.#dataProblems(report, () => after.type).map((p) => p.message)",
    replace: "",
    expect: "forgetting a required detail says the thing now falls short",
  },
  {
    name: "a rule author's message text reaches the model on rejection",
    file: "src/memory-graph.ts",
    find: "      return { focus: r.focusNode?.value, path: r.path?.value, constraint, value: r.value?.value, message }",
    replace:
      '      return { focus: r.focusNode?.value, path: r.path?.value, constraint, value: r.value?.value, message: (r.message ?? []).map((m) => m.value).join("; ") || message }',
    expect: "a lint rejection is rendered from structure",
  },
  {
    name: "sentence-like kind names are accepted (and replayed every turn)",
    file: "src/memory-graph.ts",
    find: ".filter(([, , words, chars]) => words > MAX_NAME_WORDS || chars > MAX_NAME_CHARS)",
    replace: ".filter(() => false)",
    expect: "a sentence-like kind or detail name is rejected",
  },
  // Re-verify fixes (the adversarial review's F1–F5).
  {
    name: "F2: a relation shadows text under the same key",
    file: "src/memory-graph.ts",
    find: "const LATEST_SINGLE = `seq = (SELECT max(seq) FROM triples WHERE s=t.s AND p=t.p AND ${SINGLE_VALUED})`",
    replace: "const LATEST_SINGLE = `seq = (SELECT max(seq) FROM triples WHERE s=t.s AND p=t.p)`",
    expect: "text then a relation under the same key",
  },
  {
    name: "F5: the current view orders by rowid, not seq",
    file: "src/memory-graph.ts",
    find: "const LATEST_SINGLE = `seq = (SELECT max(seq) FROM triples WHERE s=t.s AND p=t.p AND ${SINGLE_VALUED})`",
    replace:
      "const LATEST_SINGLE = `rowid = (SELECT max(rowid) FROM triples WHERE s=t.s AND p=t.p AND ${SINGLE_VALUED})`",
    expect: "the current value follows seq, not rowid",
  },
  {
    name: "F5: the v3 migration leaves the search index stale",
    file: "src/memory-graph.ts",
    find: "if (version < 3) mg.db.transaction(() => { mg.db.exec('DELETE FROM lit_fts')",
    replace: "if (false) mg.db.transaction(() => { mg.db.exec('DELETE FROM lit_fts')",
    expect: "v2→v3 migration: seq seeded",
  },
  {
    name: "F3: forgetting a type is a clean result",
    file: "src/memory-graph.ts",
    find: "const lostCoverage = wanted && forgotten.includes('type') && before.type",
    replace: "const lostCoverage = false && wanted && forgotten.includes('type') && before.type",
    expect: "forgetting a type names the rule coverage it lost",
  },
  {
    name: "F5: an empty details list forgets everything",
    file: "src/memory-graph.ts",
    find: /if \(Array\.isArray\(details\)[\s\S]*?const wanted = details \?/,
    replace: "const wanted = details?.length ?", // the original bug
    expect: "forget with an empty details list is refused",
  },
  {
    name: "F5: history does not resolve ids like describe",
    file: "src/memory-graph.ts",
    find: 'ORDER BY seq") .all(`${E}${slug(id)}`)',
    replace: 'ORDER BY seq").all(`${E}${id}`)',
    expect: "history resolves ids like describe and forget do",
  },
  {
    name: "F5: revert leaves untyped records unreported",
    file: "src/memory-graph.ts",
    find: "const untyped = affected .filter(",
    replace: "const untyped = [].filter(",
    expect: "reverting the batch that typed a record reports it as untyped",
  },
  {
    name: "F1: no character cap (run-on names pass)",
    file: "src/memory-graph.ts",
    find: "words > MAX_NAME_WORDS || chars > MAX_NAME_CHARS)",
    replace: "words > MAX_NAME_WORDS)",
    expect: "an ALLCAPS run-on instruction name is rejected",
  },
  {
    name: "F1: no character cap (lowercase run-on passes)",
    file: "src/memory-graph.ts",
    find: "words > MAX_NAME_WORDS || chars > MAX_NAME_CHARS)",
    replace: "words > MAX_NAME_WORDS)",
    expect: "a lowercase run-on instruction name is rejected",
  },
  {
    name: "F1: digits do not separate words",
    file: "src/memory-graph.ts",
    find: "split(/[^a-zA-Z]+|(?<=[a-z])(?=[A-Z])/)",
    replace: "split(/[^a-zA-Z0-9]+|(?<=[a-z0-9])(?=[A-Z])/)",
    expect: "a digit-separated instruction name is rejected",
  },
  {
    name: "F4: a store failure at turn start is silent-empty",
    file: "src/provider.ts",
    find: 'console.error("[mem] turn-start recall failed:", e instanceof Error ? e.message : String(e));',
    replace:
      'console.error("[mem] turn-start recall failed:", e instanceof Error ? e.message : String(e)); return null;',
    expect: 'a store failure at turn start injects an "unavailable" note',
  },
  {
    name: "F4: a failed store open is cached (outage becomes sticky)",
    file: "src/provider.ts",
    find: "mg.catch(() => cache.delete(key));",
    replace: "mg.catch(() => {});",
    expect: "a failed store open is retried on the next operation",
  },
  {
    name: "remember accepts uncapped type and detail names",
    file: "src/memory-graph.ts",
    // remember's own early return: extend_schema's comes first in the file and has the same text.
    find: /(dlog\("remember REJECTED \(naming\):"[^;]*;\s*)return \{ ok: false, stage: "naming", problems: naming \};/,
    replace: "void 0;",
    expect: "remember caps type and detail names like extend_schema",
  },
  {
    name: "a zero-hit recall reads as proof of absence",
    file: "src/provider.ts",
    find: "so this does NOT mean nothing is stored.",
    replace: "so nothing is stored.",
    expect: "a category query on a populated store is reported as a miss",
  },
  {
    name: "a zero-hit relate reads as proof of absence",
    file: "src/provider.ts",
    find: "that does NOT mean it isn't there.",
    replace: "it isn't there.",
    expect: "relate on a miss says it is not proof of absence",
  },
  {
    name: "a memory tool asks for approval again",
    file: "src/provider.ts",
    find: "remember: defineTool({",
    replace: 'remember: defineTool({ approval: () => "user-approval" as const,',
    expect: "no memory tool asks for approval",
  },
  {
    name: "the upgrade drops a 0.1.0 store's raw shapes",
    file: "src/memory-graph.ts",
    find: "if (rawTtl.trim()) mg.#logSchema(null, null, rawTtl, legacy);",
    replace: "",
    expect: "a 0.1.0 store keeps its types and values",
  },
  {
    name: "the upgrade seeds on every open",
    file: "src/memory-graph.ts",
    find: 'if (meta("schema_log_seeded") == null) {',
    replace: "if (true) {",
    expect: "a 0.1.0 store keeps its types and values",
  },
  {
    name: "only explicit sh:targetClass shapes make a type the owner's",
    file: "src/memory-graph.ts",
    find: ".flatMap((q) => [q.subject.value, q.object.value])",
    replace: '.filter((q) => q.predicate.value.endsWith("targetClass")).map((q) => q.object.value)',
    expect: "a type a raw shape names is the owner's",
  },
  {
    name: "the schema log stores merged definitions (an earlier entry can't be reverted)",
    file: "src/memory-graph.ts",
    find: "{ add: { requires: def.requires, relations: def.relations } },",
    replace: "{ base: merged },",
    expect: "reverting a schema change that isn't the latest removes only what it added",
  },
  // The schema log: attributed, revertable, and the source of truth on open.
  {
    name: "reverting a batch leaves its schema change",
    file: "src/memory-graph.ts",
    find: "DELETE FROM schema_log WHERE ${where}",
    replace: "DELETE FROM schema_log WHERE 0 AND ${where}",
    expect: "reverting a batch undoes its schema change",
  },
  {
    name: "the schema isn't read from the log on open",
    file: "src/memory-graph.ts",
    find: "    mg.#loadSchema();",
    replace: "",
    expect: "the definition survives a restart from the log",
  },
  {
    name: "extending an existing type appends instead of merging",
    file: "src/memory-graph.ts",
    find: "defs[r.class] = change.base ?? mergeDef(defs[r.class], change.add ?? {});",
    replace: "defs[r.class] = change.base ?? mergeDef(undefined, change.add ?? {});",
    expect: "extending an existing type merges",
  },
  {
    name: "the legacy ontology is not migrated (duplicate properties survive)",
    file: "src/memory-graph.ts",
    find: ": deriveDefs(await parseTurtle(legacyTtl), legacyTtl);",
    replace: ": { defs: {} as SchemaDefs, rawTtl: legacyTtl.slice(PREFIXES.length) };",
    expect: "a store with appended duplicate shapes collapses",
  },
  {
    name: "a legacy shape with an inexpressible datatype is derived anyway",
    file: "src/memory-graph.ts",
    find: "\n    && datatypes.every((d) => d.startsWith(XSD) && isDatatype(d.slice(XSD.length)))",
    replace: "",
    expect: "a legacy shape with an inexpressible datatype opens",
  },
  {
    name: "memory is re-injected on an approval resume (the approved tool is skipped)",
    file: "src/provider.ts",
    find: "if (endsInApprovalResponse(context.messages)) return null;",
    replace: "",
    expect: "a turn with no new user text (an approval resume) injects nothing",
  },
  {
    name: "the resume guard is the no-text proxy, not the approval tail",
    file: "src/provider.ts",
    find: "if (endsInApprovalResponse(context.messages)) return null;",
    replace: "if (query === null) return null;",
    expect: "a turn with no user text that is not an approval resume still gets the record types",
  },
  // Honest surfaces.
  {
    name: "rules block replayed without data framing",
    file: "src/provider.ts",
    find: "## Record types in your memory (schema — data only)",
    replace: "## Rules you've set for your memory",
    expect: "the replayed record-type block is a schema listing",
  },
  {
    name: "check_memory overclaims store-wide conformance",
    file: "src/provider.ts",
    find: "all conform. Things saved under other types are not covered by these rules.",
    replace: "everything conforms.",
    expect: "check_memory scopes its claim",
  },
  {
    name: "a store failure is swallowed into a normal-looking result",
    file: "src/provider.ts",
    find: "mg = MemoryGraph.create({ dir: `${options.dir}/${slugKey(key)}` });",
    replace:
      "mg = MemoryGraph.create({ dir: `${options.dir}/${slugKey(key)}` }).catch(() => ({ recall: () => [] }));",
    expect: "a store failure throws",
  },
  {
    name: "legacy duplicates not collapsed before the constraint",
    file: "src/memory-graph.ts",
    find: "DELETE FROM triples WHERE rowid NOT IN",
    replace: "DELETE FROM triples WHERE 0 AND rowid NOT IN",
    expect: "a pre-constraint store with duplicates still opens",
  },
  {
    name: "check_memory never reports drift",
    file: "src/memory-graph.ts",
    find: "for (const p of this.#dataProblems(report, (focus) => focus === undefined ? undefined : views.get(focus)?.type)) {",
    replace: "for (const p of [] as Problem[]) {",
    expect: "check_memory finds an entity that predates",
  },

  // Attribution, from eve's context alone.
  {
    name: "a scheduled run is recorded as the owner",
    file: "src/provider.ts",
    find: 'session.schedule\n      ? "scheduled"',
    replace: 'session.schedule\n      ? "owner"',
    expect: "a scheduled write lands and is recorded so",
  },
  {
    name: "a delegated task is recorded as the owner",
    file: "src/provider.ts",
    find: 'session.parent\n        ? "delegated"',
    replace: 'session.parent\n        ? "owner"',
    expect: "a delegated write lands and is recorded so",
  },
  {
    name: "another principal is recorded as the owner",
    file: "src/provider.ts",
    find: "const scopeOwner = ownedScope && speaker !== null && speaker === scope.value;",
    replace: "const scopeOwner = true;",
    expect: "a other write lands and is recorded so",
  },
  {
    name: "a write tool takes a model-declared source again",
    file: "src/provider.ts",
    find: "attributes: z",
    replace: 'source: z.enum(["user", "content"]).optional(),\nattributes: z',
    expect: "no write tool takes a model-declared source",
  },
  {
    name: "recorded origins are ignored on read",
    file: "src/memory-graph.ts",
    find: 'if (typeof o?.who === "string") return o.who as Who;',
    replace: "",
    expect: "a scheduled write replaces an owner value",
  },
  {
    name: "0.2.x grounded user writes don't read as the owner's",
    file: "src/memory-graph.ts",
    find: 'if (o?.provenance === "user" && "claimed" in o) return "owner";',
    replace: "",
    expect: "a 0.2.x store's grounded origins read as who wrote them",
  },
  {
    name: "0.2.x scheduled writes read as legacy",
    file: "src/memory-graph.ts",
    find: 'if (o?.scheduled === true) return "scheduled";',
    replace: "",
    expect: "a 0.2.x store's grounded origins read as who wrote them",
  },

  // Recall wording, from the recorded origin only.
  {
    name: "an owner-conversation value renders as the user's word",
    file: "src/provider.ts",
    find: "return `during the memory owner's own conversation${on}`;",
    replace: "return `as the user said${on}`;",
    expect: "green falcon",
  },
  {
    name: "the turn-start block drops the origin of a non-owner value",
    file: "src/provider.ts",
    find: 'return short[r.who] ? ` (${short[r.who]})` : "";',
    replace: 'return "";',
    expect: "a scheduled write lands, recalls as scheduled",
  },
  {
    name: "recall drops the note on non-owner values",
    file: "src/provider.ts",
    find: 'parts.push("", ORIGIN_NOTE)',
    replace: "void 0",
    expect: "a scheduled write lands, recalls as scheduled",
  },
  {
    name: "a record another writer typed isn't marked",
    file: "src/provider.ts",
    find: 'a.recordedType && NOT_OWNER.has(a.recordedType.who) ? `typed ${byWhom(a.recordedType)}` : "",',
    replace: '"",',
    expect: "a scheduled write lands, recalls as scheduled",
  },

  // The one control-plane rule.
  {
    name: "the owner's types are open to every writer",
    file: "src/memory-graph.ts",
    find: 'if (whoOf(origin) !== "owner" && hasOwner(origin) && this.#ownerDefined(cls)) {',
    replace: "if (false) {",
    expect: "a type the owner created can't be altered by any other writer",
  },
  {
    name: "only a scheduled run is held to the rule",
    file: "src/memory-graph.ts",
    find: 'if (whoOf(origin) !== "owner" && hasOwner(origin) && this.#ownerDefined(cls)) {',
    replace: 'if (whoOf(origin) === "scheduled" && hasOwner(origin) && this.#ownerDefined(cls)) {',
    expect: "a type the owner created can't be altered by any other writer",
  },
  {
    name: "only a type's creation makes it the owner's",
    file: "src/memory-graph.ts",
    find: "return rows.some((r) => ownerControlled(r.origin));",
    replace: "return rows.slice(0, 1).some((r) => ownerControlled(r.origin));",
    expect: "a type another writer created is the owner's once the owner extends it",
  },
  {
    name: "types and record types from before 0.3.0 are open to every writer",
    file: "src/memory-graph.ts",
    find: 'return who === "owner" || (parseOrigin(origin)?.who === undefined && who === "legacy");',
    replace: 'return who === "owner";',
    expect: "a 0.1.0 store keeps its types and values",
  },
  {
    name: "0.2.x scheduled and delegated record types count as the owner's",
    file: "src/memory-graph.ts",
    find: '(parseOrigin(origin)?.who === undefined && who === "legacy")',
    replace: "parseOrigin(origin)?.who === undefined",
    expect: "a 0.2.x store's grounded origins read as who wrote them",
  },

  {
    name: "any writer re-types the owner's record",
    file: "src/memory-graph.ts",
    find: "ownerType !== undefined &&",
    replace: "false &&",
    expect: "a record the owner typed can't be re-typed by another writer",
  },
  {
    name: "every typed record is the owner's",
    file: "src/memory-graph.ts",
    find: "const last = rows.find((r) => ownerControlled(r.origin));",
    replace: 'const last = rows.find((r) => r.ot === "iri");',
    expect: "any writer re-types one another writer typed",
  },
  {
    name: "restating a record's type counts as re-typing it",
    file: "src/memory-graph.ts",
    find: "target !== ownerType &&",
    replace: "",
    expect: "a record the owner typed can't be re-typed by another writer",
  },

  // Detection, not gates.
  {
    name: "an owner overwrite isn't counted",
    file: "src/memory-graph.ts",
    find: "this.#ownerOverwrites++;",
    replace: "",
    expect: "a scheduled write replaces an owner value",
  },
  {
    name: "the owner's own writes are counted as overwrites",
    file: "src/memory-graph.ts",
    find: 'if (writer !== "scheduled" && writer !== "delegated" && writer !== "other") return;',
    replace: "",
    expect: "only a non-owner write over an owner value is counted",
  },
  {
    name: "a write over any value is counted, not only the owner's",
    file: "src/memory-graph.ts",
    find: '.filter((r) => whoOf(r.origin) === "owner")',
    replace: "",
    expect: "only a non-owner write over an owner value is counted",
  },
  {
    name: "a forget isn't checked for owner overwrites",
    file: "src/memory-graph.ts",
    find: "this.#detectOwnerOverwrite(origin, slug(id), rows, named);",
    replace: "",
    expect: "a scheduled forget of an owner value lands, and is counted",
  },
  {
    name: "the write cap lets one extra write through",
    file: "src/provider.ts",
    find: "if (n > cap)",
    replace: "if (n > cap + 1)",
    expect: "writes past the cap throw",
  },
  {
    name: "the write cap is shared across sessions",
    file: "src/provider.ts",
    find: "const id = tool?.session?.id;",
    replace: 'const id = tool?.session ? "all" : undefined;',
    expect: "writes past the cap throw",
  },
  // The re-type rule reads the log, so a forget doesn't free a record; record-level origins stand apart from details.
  {
    name: "the re-type rule reads only the latest type row (a forget frees the record)",
    file: "src/memory-graph.ts",
    find: "const last = rows.find((r) => ownerControlled(r.origin));",
    replace: "const last = rows[0];",
    expect: "forgetting the type or the whole record doesn't free the owner's record",
  },
  {
    name: "a typeless save of a forgotten record isn't a re-type",
    file: "src/memory-graph.ts",
    find: 'const target = fact.type ? pascal(fact.type) : before.exists ? undefined : "Thing";',
    replace: "const target = fact.type ? pascal(fact.type) : undefined;",
    expect: "forgetting the type or the whole record doesn't free the owner's record",
  },
  {
    name: "the owner untyping a record doesn't release it",
    file: "src/memory-graph.ts",
    find: 'return last?.ot === "iri" ? tail(last.o) : undefined;',
    replace: "return last ? tail(last.o) : undefined;",
    expect: "once the owner untypes a record, it is open again",
  },
  {
    name: "a detail named label takes over the record name's origin",
    file: "src/memory-graph.ts",
    find: "recorded[key] = by(r);",
    replace: 'recorded[key] = by(r);\n        if (key === "label") recordedName = by(r);',
    expect: "a detail named label or type keeps its own origin",
  },
  {
    name: "a record named by another writer isn't marked",
    file: "src/provider.ts",
    find: 'a.recordedName && NOT_OWNER.has(a.recordedName.who) ? `named ${byWhom(a.recordedName)}` : "",',
    replace: '"",',
    expect: "a scheduled write lands, recalls as scheduled",
  },
  // A scope with no owner has no control-plane rule.
  {
    name: "a scope with no owner still holds types for one",
    file: "src/memory-graph.ts",
    find: "const hasOwner = (origin: string): boolean => parseOrigin(origin)?.ownedScope !== false;",
    replace: "const hasOwner = (origin: string): boolean => true;",
    expect: "in a scope with no owner, nothing is held for one",
  },
  {
    name: "every scope is recorded as owned",
    file: "src/provider.ts",
    find: "const ownedScope = isPrincipalKey(scope.value);",
    replace: "const ownedScope = true;",
    expect: "a scope that isn't one principal's has no owner",
  },
  {
    name: "no scope is recorded as owned",
    file: "src/provider.ts",
    find: "const ownedScope = isPrincipalKey(scope.value);",
    replace: "const ownedScope = false;",
    expect: "the owner's live turn is recorded as the owner's",
  },
  {
    name: "the speaker's principal drifts from the scope's by one field",
    file: "src/provider.ts",
    find: "session: { id: session.id, auth: session.auth },",
    replace:
      'session: { id: session.id, auth: { ...session.auth, current: session.auth.current && { ...session.auth.current, issuer: "drift" } } },',
    expect: "the owner's live turn is recorded as the owner's",
  },
  // eve 0.84 and later.
  {
    name: "compaction recall is back (eve's compiler rejects the key)",
    file: "src/provider.ts",
    find: 'recall: { "turn.started": recall },',
    replace: 'recall: { "turn.started": recall, "compaction.completed": recall },',
    expect: "as a memory definition",
  },
  {
    name: "the recall and the outage note have different ids",
    file: "src/provider.ts",
    find: "id: RECALL_ID,",
    replace: 'id: "shacl-memory-unavailable",',
    expect: 'a store failure at turn start injects an "unavailable" note',
  },
  {
    name: "the outage note outlives the outage when nothing is recalled",
    file: "src/provider.ts",
    find: 'if (seen === undefined || shown.get(seen) === "recall") return null;',
    replace: "return null;",
    expect: "and the next healthy turn replaces it",
  },
  {
    name: "every turn with nothing to recall sends a message",
    file: "src/provider.ts",
    find: 'if (seen === undefined || shown.get(seen) === "recall") return null;',
    replace: "if (seen === undefined) return null;",
    expect: "and the next healthy turn replaces it",
  },
  {
    name: "only an outage this process saw is replaced (a restart keeps the note)",
    file: "src/provider.ts",
    find: 'if (seen === undefined || shown.get(seen) === "recall") return null;',
    replace: 'if (seen === undefined || shown.get(seen) !== "outage") return null;',
    expect: "and the next healthy turn replaces it",
  },
  {
    name: "a seq freed by revertBatch is reused",
    file: "src/memory-graph.ts",
    find: "(SELECT max(ifnull(max(seq), 0), ifnull((${SEQ_HWM_SQL}), 0)) + 1 FROM triples)",
    replace: "(SELECT ifnull(max(seq), 0) + 1 FROM triples)",
    expect: "keeps its value when revertBatch deletes the latest rows",
  },
  {
    name: "the high-water mark doesn't move with a write",
    file: "src/memory-graph.ts",
    find: "mark.run(String(seq));",
    replace: "",
    expect: "starts at 0 and follows every write",
  },
  {
    name: "a 0.3 store gets no high-water mark",
    file: "src/memory-graph.ts",
    find: "SELECT 'seq_hwm', CAST(ifnull(max(seq), 0) AS TEXT) FROM triples;",
    replace: "SELECT 'seq_hwm', '0' WHERE 0;",
    expect: "seeds seq_hwm from max(seq)",
  },
  {
    name: "an emptied search index reads as matching",
    file: "src/stats.ts",
    find: "if (i && (i.missing > 0 || i.extra > 0))",
    replace: "if (i && i.extra > 0)",
    expect: "an emptied search index",
  },
  {
    name: "ownership isn't compared",
    file: "src/stats.ts",
    find: "if (owner && (f.uid !== owner.uid || f.gid !== owner.gid))",
    replace: "if (false)",
    expect: "a file the agent's user doesn't own",
  },
  {
    name: "the stats open the store writable",
    file: "src/stats.ts",
    find: "{ readonly: true, fileMustExist: true }",
    replace: "{ fileMustExist: true }",
    expect: "opens a store that refuses writes",
  },
  {
    name: "a scope that can't be entered is skipped as if removed",
    file: "src/stats.ts",
    find: "    } catch {\n      return true;\n    }",
    replace: "    } catch {\n      return false;\n    }",
    expect: "a scope directory that can't be entered is reported as unreadable",
  },
  {
    name: "rows past the mark go unreported",
    file: "src/stats.ts",
    find: "if (s.seqHwm != null && s.maxSeq !== undefined && s.maxSeq > s.seqHwm)",
    replace: "if (false)",
    expect: "rows an older adapter wrote past the mark",
  },
  {
    name: "the running user isn't compared",
    file: "src/stats.ts",
    find: "if (uid !== undefined && f.uid !== uid)",
    replace: "if (false)",
    expect: "files owned by someone other than the running user",
  },
  {
    name: "the owner's read and write mode isn't checked",
    file: "src/stats.ts",
    find: "if ((f.mode & 0o600) !== 0o600)",
    replace: "if (false)",
    expect: "a file its owner can't read and write",
  },
];

// Anchors survive the formatter: whitespace, line breaks around brackets, trailing commas and quote style are not part
// of the code a mutation targets, so a reflow must not turn a guard STALE.
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
      { cwd: dir, encoding: "utf8", env: { ...process.env, EVE_MEMORY_DEBUG: "0" } },
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
