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
  file: "src/memory-graph.ts" | "src/provider.ts";
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
  "src/shacl-shacl.data.ts",
  "vitest.unit.config.ts",
  "vitest.integration.config.ts",
  "src/memory-graph.test.ts",
  "src/memory-graph.integration.test.ts",
  "src/provider.integration.test.ts",
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
    find: "else if (r.ot === 'lit' && r.p.startsWith(P)) attributes[key] = r.o",
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
    find: "seq = (SELECT max(seq) FROM triples WHERE s=t.s AND p=t.p AND ${SINGLE_VALUED}) AND ot != 'tomb'",
    replace:
      "seq = (SELECT min(seq) FROM triples WHERE s=t.s AND p=t.p AND ${SINGLE_VALUED}) AND ot != 'tomb'",
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
    find: "for (const r of rows) this.#ins.run(s, r.p, isRelation(r.p, r.ot) ? r.o : '', isRelation(r.p, r.ot) ? 'tomb-edge' : 'tomb', null, at, origin)",
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
    find: "seq = (SELECT max(seq) FROM triples WHERE s=t.s AND p=t.p AND ${SINGLE_VALUED}) AND ot != 'tomb'",
    replace: "seq = (SELECT max(seq) FROM triples WHERE s=t.s AND p=t.p) AND ot != 'tomb'",
    expect: "text then a relation under the same key",
  },
  {
    name: "F5: the current view orders by rowid, not seq",
    file: "src/memory-graph.ts",
    find: "seq = (SELECT max(seq) FROM triples WHERE s=t.s AND p=t.p AND ${SINGLE_VALUED}) AND ot != 'tomb'",
    replace:
      "rowid = (SELECT max(rowid) FROM triples WHERE s=t.s AND p=t.p AND ${SINGLE_VALUED}) AND ot != 'tomb'",
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
  // Trust gates (red-team: memory poisoning through handed content).
  {
    name: "filed values are not marked on read",
    file: "src/memory-graph.ts",
    find: 'if (o?.provenance === "content") filed[key] = from;',
    replace: "if (false) filed[key] = from;",
    expect: "a fact filed from handed content is marked unconfirmed",
  },
  {
    name: "writes do not record where they came from",
    file: "src/provider.ts",
    find: ': isUser ? "user" : "content";',
    replace: ': "user";',
    expect: "a fact filed from handed content is marked unconfirmed",
  },
  {
    name: "the turn-start block drops the filed mark",
    file: "src/provider.ts",
    find: ': " ⟨unconfirmed⟩";',
    replace: ': "";',
    expect: "the turn-start block marks filed values too",
  },
  // G1: the twin catch is id-agnostic and compares normalized names.
  {
    name: "a fresh id skips the second-record check",
    file: "src/memory-graph.ts",
    find: "if (isContent(origin) && fact.label && !held && String(fact.label) !== before.label) {",
    replace:
      "if (isContent(origin) && !fact.id && fact.label && !held && String(fact.label) !== before.label) {",
    expect: "a fresh id does not dodge the check",
  },
  {
    name: "names compare exactly (varied spellings dodge the check)",
    file: "src/memory-graph.ts",
    find: "function sameName(a: string, b: string): boolean {",
    replace:
      "function sameName(a: string, b: string): boolean {\n  return a.toLowerCase() === b.toLowerCase();",
    expect: "a varied spelling of an existing name is caught",
  },
  {
    name: "initials do not stand for words",
    file: "src/memory-graph.ts",
    find: "(t.length === 1 && u.startsWith(t)) || (u.length === 1 && t.startsWith(u))",
    replace: "false",
    expect: "an initial stands for the word it begins",
  },
  {
    name: "names match on any one shared word",
    file: "src/memory-graph.ts",
    find: "if (i < 0) return false;",
    replace: "if (i < 0) continue;",
    expect: "different names and a run of initials are not twins",
  },
  {
    name: "a renamed record is still matched by its old name",
    file: "src/memory-graph.ts",
    find: "const existing = this.#view(sub).label;",
    replace: 'const existing = this.history(tail(sub)).find((h) => h.key === "label")?.value;',
    expect: "only the current name counts",
  },

  // Values approved before writes were grounded still read as approved, with where they came from.
  {
    name: "an approved value loses where it came from (core)",
    file: "src/memory-graph.ts",
    find: 'else if (o?.provenance === "content-approved") approved[key] = from;',
    replace: "",
    expect: "a value approved before writes were grounded still reads as approved",
  },
  {
    name: "an approved value is rendered with no provenance",
    file: "src/provider.ts",
    find: "const approved = marks.approved?.[k];",
    replace: "const approved = undefined;",
    expect: "a value approved before writes were grounded still reads as approved",
  },
  {
    name: "a same-name second record from handed content is written beside the user's",
    file: "src/memory-graph.ts",
    find: "if (twin) {",
    replace: "if (false) {",
    expect: "writes nothing, whatever id or spelling",
  },
  // Precedence: what the user stated outranks handed content (red-team receipts: an overwritten phone, a forgotten
  // client, a planted required field). Content adds beside the user's values; it never replaces or retracts them.
  {
    name: "handed content replaces a value the user stated",
    file: "src/memory-graph.ts",
    find: "if (!c) return true;",
    replace: "return true;",
    expect: "content can't supersede a value the user stated",
  },
  {
    name: "handed content forgets what the user stated",
    file: "src/memory-graph.ts",
    find: "const stated = isContent(origin) ? named.filter((r) => outranksContent(r.origin)) : [];",
    replace: "const stated: typeof named = [];",
    expect: "content can't forget a detail the user stated",
  },
  {
    name: "handed content changes a record type the user defined",
    file: "src/memory-graph.ts",
    find: "if (isContent(origin) && cls in this.#schemaDefs) {",
    replace: "if (false) {",
    expect: "content can't change a record type the user defined",
  },
  {
    name: "content can't correct what content wrote (everything outranks content)",
    file: "src/memory-graph.ts",
    find: '!["content", "agent-state"].includes(provenanceOf(origin));',
    replace: "true;",
    expect: "content updates and forgets what content wrote",
  },
  {
    name: "the agent's declared state is ranked like a belief",
    file: "src/memory-graph.ts",
    find: '!["content", "agent-state"].includes(provenanceOf(origin));',
    replace: '!["content"].includes(provenanceOf(origin));',
    expect: "the agent's declared state isn't ranked",
  },
  {
    name: "values approved before grounding don't outrank content",
    file: "src/memory-graph.ts",
    find: '!["content", "agent-state"].includes(provenanceOf(origin));',
    replace: '!["content", "agent-state", "content-approved"].includes(provenanceOf(origin));',
    expect: "values from before writes were grounded rank as the user's",
  },
  {
    name: "a memory tool asks for approval again",
    file: "src/provider.ts",
    find: "remember: defineTool({",
    replace: 'remember: defineTool({ approval: () => "user-approval" as const,',
    expect: "no memory tool asks for approval",
  },
  {
    name: "content renames its own record onto the user's record's name",
    file: "src/memory-graph.ts",
    find: "if (isContent(origin) && fact.label && !held && String(fact.label) !== before.label) {",
    replace: "if (isContent(origin) && fact.label && !held && !before.exists) {",
    expect: "content can't rename its own record onto the user's record's name",
  },
  {
    name: "the upgrade drops a 0.1.0 store's raw shapes",
    file: "src/memory-graph.ts",
    find: "if (rawTtl.trim()) mg.#logSchema(null, null, rawTtl, legacy);",
    replace: "",
    expect: "a 0.1.0 store upgrades with its types intact",
  },
  {
    name: "the upgrade seeds a 0.1.0 store's types as content",
    file: "src/memory-graph.ts",
    find: 'const legacy = JSON.stringify({ source: "legacy" });',
    replace: 'const legacy = JSON.stringify({ provenance: "content" });',
    expect: "a 0.1.0 store upgrades with its types intact",
  },
  {
    name: "the upgrade seeds on every open",
    file: "src/memory-graph.ts",
    find: 'if (meta("schema_log_seeded") == null) {',
    replace: "if (true) {",
    expect: "a 0.1.0 store upgrades with its types intact",
  },
  {
    name: "content takes over a stated value by resending it as another datatype",
    file: "src/memory-graph.ts",
    find: "if (c.o === w.o) return false;",
    replace: "if (c.o === w.o) return true;",
    expect: "content can't take over a value the user stated by resending it as another datatype",
  },
  {
    name: "a raw shape from content is accepted",
    file: "src/memory-graph.ts",
    find: /if \(isContent\(origin\)\) \{\s*dlog\("extend_schema REJECTED \(raw shape from content\)"\);/,
    replace: 'if (false) { dlog("extend_schema REJECTED (raw shape from content)");',
    expect: "a raw shape from content is refused",
  },
  {
    name: "content defines a type only a raw shape of the user's covers",
    file: "src/memory-graph.ts",
    find: "if (isContent(origin) && this.#rawClasses.has(cls)) {",
    replace: "if (false) {",
    expect: "content can't define a type the user's raw shape already covers",
  },
  {
    name: "only explicit sh:targetClass shapes make a type the user's",
    file: "src/memory-graph.ts",
    find: ".flatMap((q) => [q.subject.value, q.object.value])",
    replace: '.filter((q) => q.predicate.value.endsWith("targetClass")).map((q) => q.object.value)',
    expect: "a raw shape that is its own class target makes that type the user's",
  },
  {
    name: "a raw shape protects a type only when no defined type has the name",
    file: "src/memory-graph.ts",
    find: "if (isContent(origin) && this.#rawClasses.has(cls)) {",
    replace: "if (isContent(origin) && !(cls in this.#schemaDefs) && this.#rawClasses.has(cls)) {",
    expect: "content can't add to its own type once the user's raw shape covers it",
  },
  {
    name: "the schema log stores merged definitions (an earlier entry can't be reverted)",
    file: "src/memory-graph.ts",
    find: "{ add: { requires: def.requires, relations: def.relations } },",
    replace: "{ base: merged },",
    expect: "reverting a schema change that isn't the latest removes only what it added",
  },
  {
    name: "source is defined by where information came from, not who conveyed it",
    file: "src/provider.ts",
    find: "Decide by who conveyed it to you, not by where the information first came from.",
    replace: 'If unsure, use \\"content\\".',
    expect: "every write tool tells the model that source is who conveyed it",
  },
  // Grounding: the model's "user" counts only on a live turn by the person whose memory this is.
  {
    name: "a scheduled run counts as the user",
    file: "src/provider.ts",
    find: "const live = session !== undefined && !session.schedule && !session.parent;",
    replace: "const live = session !== undefined && !session.parent;",
    expect: "from a scheduled run",
  },
  {
    name: "a delegated task counts as the user",
    file: "src/provider.ts",
    find: "const live = session !== undefined && !session.schedule && !session.parent;",
    replace: "const live = session !== undefined && !session.schedule;",
    expect: "from a delegated task",
  },
  {
    name: "another principal writing into the scope counts as the user",
    file: "src/provider.ts",
    find: "speaker !== null && speaker === scope.value",
    replace: "true",
    expect: "from a request from someone other than the user",
  },
  {
    name: "a write with no source counts as the user's",
    file: "src/provider.ts",
    find: 'input.source === "user" && live',
    replace: 'input.source !== "content" && live',
    expect: "a write with no source is never the user's",
  },
  // agentState: declared by id, by the agent's author.
  {
    name: "the agentState exemption is dropped",
    file: "src/provider.ts",
    find: "input.id !== undefined && agentState.has(slug(input.id))",
    replace: "false",
    expect: "another agent's request replaces and clears an item",
  },
  {
    name: "agent state is matched by the record's name instead of its id",
    file: "src/provider.ts",
    find: "input.id !== undefined && agentState.has(slug(input.id))",
    replace: 'agentState.has(slug((input as { label?: string }).label ?? input.id ?? ""))',
    expect: "a record is the agent's state by its declared id, not by its name",
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
