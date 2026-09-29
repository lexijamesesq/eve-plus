// @eve-plus/memory — core adapter. STORE: better-sqlite3 (triples table + FTS5), disk-backed, bounded machine
// RAM, natively crash-safe (WAL). ONTOLOGY/VALIDATION: SHACL over rdf-validate-shacl. The agent never sees
// RDF/SQL: it calls remember/recall/relate/extendSchema with plain JSON; this maps NL↔RDF/SQL internally.
// "The only gate is does it lint." (Store chosen mechanically — bake-off: SQLite bounds RAM where
// quadstore+comunica inflated it +1GB@100k.)

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import rdf from "@zazuko/env-node";
import Database from "better-sqlite3";
import SHACLValidator from "rdf-validate-shacl";
import SHACL_SHACL_TTL from "./shacl-shacl.data.js"; // inlined W3C SHACL-SHACL — bundler-safe (no runtime file load)

export interface Problem {
  focus?: string;
  path?: string;
  constraint?: string;
  value?: string;
  message: string;
}
export type Ok<T> = { ok: true } & T;
export type Fail = { ok: false; stage: string; problems: Problem[] };

export type Datatype = "string" | "integer" | "decimal" | "boolean" | "date";
export interface RememberInput {
  id?: string;
  type?: string;
  label?: string;
  attributes?: Record<string, string | number | boolean>;
  relations?: { relation: string; to: string }[];
}
export interface SlotDef {
  slot: string;
  datatype?: Datatype;
  minCount?: number;
  maxCount?: number;
  message?: string;
}
export interface RelationDef {
  relation: string;
  minCount?: number;
  maxCount?: number;
}
export interface ExtendInput {
  class?: string;
  requires?: SlotDef[];
  relations?: RelationDef[];
  rawShape?: string;
}
export interface Change {
  key: string;
  from: string;
  to: string;
}
export interface Fact {
  id?: string;
  label?: string;
  type?: string;
  attributes?: Record<string, string>;
  /** Keys whose current value was filed from handed content (not stated by the user) → where it came from. */
  filed?: Record<string, string>;
  /** Keys whose current value came from handed content and the person approved → where it came from. */
  approved?: Record<string, string>;
}
export interface RelateResult {
  found: boolean;
  entity?: string;
  label?: string;
  type?: string;
  attributes?: Record<string, string>;
  filed?: Record<string, string>;
  approved?: Record<string, string>;
  connections: { relation: string; target: string }[];
}
export interface ShapeEntry {
  class: string;
  classIri: string;
  requires: { slot: string; required: boolean }[];
  relations: { slot: string; required: boolean }[];
  summary: string;
}
export interface CheckResult {
  rules: number;
  checked: number;
  issues: { id: string; label?: string; type?: string; messages: string[] }[];
  truncated: boolean;
}
export type RememberResult = Ok<{ id: string; summary: string; superseded: Change[] }> | Fail;
export type ForgetResult =
  | {
      ok: true;
      label: string;
      whole: boolean;
      forgotten: string[];
      breaks: string[];
      lostCoverage: { from: string; rules: string[] } | null;
    }
  | { ok: false; reason: string };
export type ExtendResult = Ok<{ class: string; merged?: boolean; rule?: string }> | Fail;
export interface Description {
  id: string;
  label?: string;
  type?: string;
  attributes: Record<string, string>;
  relations: { relation: string; to: string }[];
  filed: Record<string, string>;
  approved: Record<string, string>;
}
export interface HistoryEntry {
  key: string;
  value: string;
  writtenAt: string | null;
  origin: Record<string, unknown> | null;
}

type Dataset = Awaited<ReturnType<typeof parseTurtle>>;
type Term = NonNullable<Parameters<Dataset["match"]>[0]>;
type Report = Awaited<ReturnType<SHACLValidator["validate"]>>;
type Triple = { s: string; p: string; o: string; ot: string; dt: string | null };
type StoredTriple = Triple & { origin: string | null };
// Canonical record-type definition, one per class: what extend_schema merges into and the ontology is rendered from.
type SlotRule = {
  datatype?: Datatype;
  minCount?: number;
  maxCount?: number;
  message?: string;
  name?: string;
};
type RelationRule = { minCount?: number; maxCount?: number; name?: string };
type TypeDef = { requires: Record<string, SlotRule>; relations: Record<string, RelationRule> };
type SchemaDefs = Record<string, TypeDef>;
type View = {
  exists: boolean;
  type?: string;
  label?: string;
  attributes: Record<string, string>;
  relations: Triple[];
  rows: Triple[];
  filed: Record<string, string>;
  approved: Record<string, string>;
};

const B = "https://eve.local/mem/";
const C = `${B}c/`,
  P = `${B}p/`,
  E = `${B}e/`;
const RDFNS = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"; // rdf:type lives here (SHACL sh:targetClass matches it)
const RDFS = "http://www.w3.org/2000/01/rdf-schema#";
const XSD = "http://www.w3.org/2001/XMLSchema#";
const SH = "http://www.w3.org/ns/shacl#";
const PREFIXES = `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix rdf: <${RDFNS}> .
@prefix rdfs: <${RDFS}> .
@prefix xsd: <${XSD}> .
@prefix c: <${C}> .
@prefix p: <${P}> .
@prefix e: <${E}> .
`;
const DT: Record<Datatype, string> = {
  string: "xsd:string",
  integer: "xsd:integer",
  decimal: "xsd:decimal",
  boolean: "xsd:boolean",
  date: "xsd:date",
};
const isDatatype = (d: string | undefined): d is Datatype =>
  d !== undefined && Object.hasOwn(DT, d);

const slug = (s: unknown) =>
  String(s)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "x";
const pascal = (s: unknown) =>
  String(s)
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("") || "X";
const esc = (s: unknown) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const tail = (iri: string) => iri.split("/").pop() ?? iri;
// Two names are the same name when they differ only in case, accents, punctuation, spacing or word order, or when an
// initial stands for a word it begins ("J. Lee" is "Jordan Lee").
const nameTokens = (s: string) =>
  String(s)
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .match(/[a-z0-9]+/g) ?? [];
function sameName(a: string, b: string): boolean {
  const x = nameTokens(a);
  const rest = nameTokens(b);
  if (x.length === 0 || x.length !== rest.length) return false;
  for (const t of x) {
    const i = rest.findIndex(
      (u) => u === t || (t.length === 1 && u.startsWith(t)) || (u.length === 1 && t.startsWith(u)),
    );
    if (i < 0) return false;
    rest.splice(i, 1);
  }
  return true;
}
// FTS5 MATCH from free text: tokenize, drop 1–2 char noise (with a fallback so an all-short query still runs),
// quote each token, OR-join. A single quoted phrase would require the whole string to appear adjacent+in-order —
// so a multi-word query could never match a stored literal. OR over tokens is the "any word matches" recall we want.
const ftsQuery = (s: string) => {
  const tokens =
    String(s)
      .toLowerCase()
      .match(/[a-z0-9]+/g) || [];
  const use = tokens.filter((t) => t.length >= 3);
  const terms = use.length ? use : tokens;
  return terms.length ? terms.map((t) => `"${t}"`).join(" OR ") : null;
};
const xsdOf = (v: unknown) =>
  typeof v === "number"
    ? Number.isInteger(v)
      ? `${XSD}integer`
      : `${XSD}decimal`
    : typeof v === "boolean"
      ? `${XSD}boolean`
      : `${XSD}string`;
// Names are replayed to the model every turn, so they are capped in words AND characters. Words alone are not enough:
// a run-on or ALLCAPS sentence with no separators counts as one "word" (bypassed live), so the character cap on the
// identifier as replayed is what bounds the payload. Digits separate words too ("Reply0only0in0French" is 4 words).
const MAX_NAME_WORDS = 3;
const MAX_NAME_CHARS = 24;
const wordsIn = (name: string) =>
  String(name)
    .trim()
    .split(/[^a-zA-Z]+|(?<=[a-z])(?=[A-Z])/)
    .filter(Boolean).length;
// Both authoring surfaces (extend_schema kinds/details, remember types/keys/connections) put names in front of the
// model every turn, so both obey the same caps: one path capping names while the other doesn't was a coverage gap, and
// uncapped names also eat the turn-start budget.
const nameProblems = (names: [what: string, name: string, replayed: string][]): Problem[] =>
  names
    .map(([what, name, replayed]) => [what, String(name), wordsIn(name), replayed.length] as const)
    .filter(([, , words, chars]) => words > MAX_NAME_WORDS || chars > MAX_NAME_CHARS)
    .map(([what, name, words, chars]) => ({
      message: `A ${what} name should be a short noun of up to ${MAX_NAME_WORDS} words and ${MAX_NAME_CHARS} characters (e.g. ClientContact, phone); "${name.slice(0, 60)}" has ${words} word(s), ${chars} character(s).`,
    }));
const litTerm = (o: string, dt: string | null) =>
  dt && dt !== `${XSD}string` ? `"${esc(o)}"^^<${dt}>` : `"${esc(o)}"`;

// Runtime-proof instrumentation, off by default (production-clean). EVE_MEMORY_DEBUG=1 → stderr [mem] lines.
const DEBUG = process.env.EVE_MEMORY_DEBUG === "1";
const dlog = (...a: unknown[]) => {
  if (DEBUG) console.error("[mem]", ...a);
};

async function parseTurtle(str: string) {
  const stream = rdf.formats.parsers.import("text/turtle", Readable.from([str]));
  if (!stream) throw new Error("no text/turtle parser is registered");
  return await rdf.dataset().import(stream);
}
const localName = (iri: string) =>
  iri.startsWith(C) ? iri.slice(C.length) : (iri.split(/[#/]/).pop() ?? iri);
const first = (ds: Dataset, s: Term, p: string) =>
  [...ds.match(s, rdf.namedNode(SH + p), null)][0]?.object;

// The authored rules, read straight off the SHACL shapes graph: one entry per sh:targetClass binding.
function indexShapes(ds: Dataset): ShapeEntry[] {
  const out: ShapeEntry[] = [];
  for (const t of ds.match(null, rdf.namedNode(`${SH}targetClass`), null)) {
    const requires: ShapeEntry["requires"] = [],
      relations: ShapeEntry["relations"] = [];
    for (const pq of ds.match(t.subject, rdf.namedNode(`${SH}property`), null)) {
      const path = first(ds, pq.object, "path")?.value;
      if (!path) continue;
      const slot = path.split(/[#/]/).pop() ?? path;
      const required = Number(first(ds, pq.object, "minCount")?.value ?? 0) > 0;
      const isRelation = first(ds, pq.object, "nodeKind")?.value === `${SH}IRI`;
      (isRelation ? relations : requires).push({ slot, required });
    }
    const cls = localName(t.object.value);
    const req = requires.filter((r) => r.required).map((r) => r.slot);
    const rel = relations.filter((r) => r.required).map((r) => r.slot);
    const checks = requires.filter((r) => !r.required).map((r) => r.slot);
    const parts: string[] = [];
    if (req.length) parts.push(`requires ${req.join(", ")}`);
    if (rel.length) parts.push(`must connect via ${rel.join(", ")}`);
    if (checks.length) parts.push(`checks ${checks.join(", ")} when present`);
    out.push({
      class: cls,
      classIri: t.object.value,
      requires,
      relations,
      summary: `${cls} (${parts.join("; ") || "no required details"})`,
    });
  }
  return out;
}

function mergeDef(
  existing: TypeDef | undefined,
  def: { requires?: SlotDef[]; relations?: RelationDef[] },
): TypeDef {
  const out: TypeDef = {
    requires: { ...existing?.requires },
    relations: { ...existing?.relations },
  };
  for (const r of def.requires ?? [])
    out.requires[slug(r.slot)] = {
      ...out.requires[slug(r.slot)],
      ...stripUndefined({
        datatype: r.datatype,
        minCount: r.minCount,
        maxCount: r.maxCount,
        message: r.message,
        name: r.slot,
      }),
    };
  for (const r of def.relations ?? [])
    out.relations[slug(r.relation)] = {
      ...out.relations[slug(r.relation)],
      ...stripUndefined({ minCount: r.minCount, maxCount: r.maxCount, name: r.relation }),
    };
  return out;
}
const provenanceOf = (origin: string | null) => {
  try {
    return JSON.parse(origin ?? "null")?.provenance ?? "unmarked";
  } catch {
    return "unmarked";
  }
};
const stripUndefined = <T extends object>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
function shapeTtl(cls: string, d: TypeDef) {
  const props: string[] = [];
  for (const [slot, r] of Object.entries(d.requires)) {
    const parts = [`sh:path p:${slot}`, `sh:datatype ${DT[r.datatype ?? "string"]}`];
    if (r.minCount != null) parts.push(`sh:minCount ${r.minCount}`);
    if (r.maxCount != null) parts.push(`sh:maxCount ${r.maxCount}`);
    parts.push(`sh:name "${esc(r.name ?? slot)}"`);
    parts.push(
      `sh:message "${esc(r.message ?? `${cls} requires '${r.name ?? slot}' (${r.datatype ?? "string"}).`)}"`,
    );
    props.push(`  sh:property [ ${parts.join(" ; ")} ] ;`);
  }
  for (const [rel, r] of Object.entries(d.relations)) {
    const parts = [`sh:path p:${rel}`, `sh:nodeKind sh:IRI`];
    if (r.minCount != null) parts.push(`sh:minCount ${r.minCount}`);
    if (r.maxCount != null) parts.push(`sh:maxCount ${r.maxCount}`);
    parts.push(`sh:name "${esc(r.name ?? rel)}"`);
    parts.push(
      `sh:message "${esc(`${cls}.${r.name ?? rel} must connect to another remembered thing.`)}"`,
    );
    props.push(`  sh:property [ ${parts.join(" ; ")} ] ;`);
  }
  return `\nc:${cls}Shape a sh:NodeShape ;\n  sh:targetClass c:${cls} ;\n${props.join("\n")}\n  sh:closed false .\n`;
}
const renderOntology = (defs: SchemaDefs, rawTtl: string) =>
  PREFIXES +
  Object.entries(defs)
    .map(([cls, d]) => shapeTtl(cls, d))
    .join("") +
  rawTtl;
// One-time migration from the appended-text ontology: every sh:targetClass shape under our namespace becomes (or merges
// into) a canonical definition. A store holding any other kind of shape keeps its whole legacy text as raw, unmerged —
// including a class shape whose datatype a definition cannot express (only a raw shape could have authored one).
function deriveDefs(ds: Dataset, legacyTtl: string): { defs: SchemaDefs; rawTtl: string } {
  const nodeShapes = [
    ...ds.match(null, rdf.namedNode(`${RDFNS}type`), rdf.namedNode(`${SH}NodeShape`)),
  ].map((q) => q.subject);
  const datatypes = [...ds.match(null, rdf.namedNode(`${SH}datatype`), null)].map(
    (q) => q.object.value,
  );
  const derivable =
    nodeShapes.every((sh) => first(ds, sh, "targetClass")?.value.startsWith(C)) &&
    datatypes.every((d) => d.startsWith(XSD) && isDatatype(d.slice(XSD.length)));
  if (!derivable)
    return {
      defs: {},
      rawTtl: legacyTtl.startsWith(PREFIXES) ? legacyTtl.slice(PREFIXES.length) : legacyTtl,
    };
  const defs: SchemaDefs = {};
  for (const sh of nodeShapes) {
    const cls = localName(first(ds, sh, "targetClass")?.value);
    const requires: SlotDef[] = [],
      relations: RelationDef[] = [];
    for (const pq of ds.match(sh, rdf.namedNode(`${SH}property`), null)) {
      const path = first(ds, pq.object, "path")?.value;
      if (!path) continue;
      const num = (k: string) => {
        const v = first(ds, pq.object, k)?.value;
        return v == null ? undefined : Number(v);
      };
      const name = first(ds, pq.object, "name")?.value ?? path.split(/[#/]/).pop() ?? path;
      const datatype = first(ds, pq.object, "datatype")?.value.split("#").pop();
      if (first(ds, pq.object, "nodeKind")?.value === `${SH}IRI`)
        relations.push({ relation: name, minCount: num("minCount"), maxCount: num("maxCount") });
      else
        requires.push({
          slot: name,
          datatype: isDatatype(datatype) ? datatype : undefined,
          minCount: num("minCount"),
          maxCount: num("maxCount"),
        });
    }
    defs[cls] = mergeDef(defs[cls], { requires, relations });
  }
  return { defs, rawTtl: "" };
}

function reportProblems(report: Report): Problem[] {
  return report.results.map((r) => ({
    focus: r.focusNode?.value,
    path: r.path?.value,
    constraint: r.sourceConstraintComponent?.value?.split(/[#/]/).pop(),
    value: r.value?.value,
    message: (r.message ?? []).map((m) => m.value).join("; ") || "(no message)",
  }));
}

const TYPE = `${RDFNS}type`;
const LABEL = `${RDFS}label`;
const EDGE = `ot IN ('iri','tomb-edge') AND p LIKE '${P}%'`;
const SINGLE_VALUED = `NOT (${EDGE})`;
const isRelation = (p: string, ot: string) =>
  (ot === "iri" || ot === "tomb-edge") && p.startsWith(P);
const keyOf = (p: string) => (p === TYPE ? "type" : p === LABEL ? "label" : tail(p));
// Forgetting appends a tombstone rather than deleting: 'tomb' retracts a single-valued key, 'tomb-edge' one edge.
const toTtl = (rows: Triple[]) =>
  rows
    .map((t) => `<${t.s}> <${t.p}> ${t.ot === "iri" ? `<${t.o}>` : litTerm(t.o, t.dt)} .`)
    .join("\n");
const DIRECT = JSON.stringify({ source: "direct" });
// The same input always fingerprints the same: object keys are sorted at every depth and absent fields dropped, so key
// order or an omitted optional never makes two identical inputs differ.
const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v !== null && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v)
            .filter(([, x]) => x !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, x]) => [k, canonical(x)]),
        )
      : v;
const fingerprint = (input: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(input) ?? null))
    .digest("hex");
const withoutOrigin = ({ s, p, o, ot, dt }: StoredTriple): Triple => ({ s, p, o, ot, dt });

export class MemoryGraph {
  /** The underlying SQLite store — exposed read-only for operator inspection. */
  readonly db: Database.Database;
  #schemaDefs: SchemaDefs = {};
  #rawTtl = "";
  #ontologyTtl = PREFIXES;
  #metaValidator!: SHACLValidator;
  #shapes!: Dataset;
  #dataValidator!: SHACLValidator;
  #shapeIndex: ShapeEntry[] = [];
  #ins!: Database.Statement<[string, string, string, string, string | null, string, string]>;
  #insF!: Database.Statement<[string, string]>;
  #delF!: Database.Statement<[string]>;
  #current!: Database.Statement<[string], StoredTriple>;
  #relations!: Database.Statement<[string], StoredTriple>;
  #currentOfType!: Database.Statement<[string, number], { s: string }>;

  private constructor(db: Database.Database) {
    this.db = db;
  }

  static async create({ dir }: { dir?: string } = {}): Promise<MemoryGraph> {
    if (dir) mkdirSync(dir, { recursive: true });
    // One SQLite file IS the store (WAL → crash-safe, disk-backed, bounded machine RAM). :memory: for tests.
    const mg = new MemoryGraph(new Database(dir ? join(dir, "graph.db") : ":memory:"));
    dlog(
      "store opened — better-sqlite3 native binding loaded OK at",
      dir ? join(dir, "graph.db") : ":memory:",
    );
    mg.db.pragma("journal_mode = WAL");
    mg.db.pragma("synchronous = NORMAL");
    // The triple table is an append-only log: a write never overwrites or deletes. Each row carries when and by
    // whom (origin: scope + eve session/turn/tool-call) it was written, so a bad batch can be found and reverted.
    mg.db.exec(`CREATE TABLE IF NOT EXISTS triples(s TEXT, p TEXT, o TEXT, ot TEXT, dt TEXT, written_at TEXT, origin TEXT, seq INTEGER);
                CREATE INDEX IF NOT EXISTS i_s ON triples(s);
                CREATE INDEX IF NOT EXISTS i_po ON triples(p,o);
                CREATE INDEX IF NOT EXISTS i_sp ON triples(s,p);
                CREATE VIRTUAL TABLE IF NOT EXISTS lit_fts USING fts5(s UNINDEXED, o);
                CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
                CREATE TABLE IF NOT EXISTS held_approvals(call_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL);
                DROP TABLE IF EXISTS pending_approvals;`);
    const version = mg.db.pragma("user_version", { simple: true }) as number;
    const columns = () =>
      (mg.db.prepare("PRAGMA table_info(triples)").all() as { name: string }[]).map((c) => c.name);
    // v0 → v1: stores written before set semantics may hold exact duplicate rows; collapse them.
    if (version < 1) {
      mg.db.transaction(() => {
        mg.db.exec(`DELETE FROM triples WHERE rowid NOT IN (SELECT MIN(rowid) FROM triples GROUP BY s, p, o, ot, ifnull(dt, ''));
                    DELETE FROM lit_fts WHERE rowid NOT IN (SELECT MIN(rowid) FROM lit_fts GROUP BY s, o);`);
        mg.db.pragma("user_version = 1");
      })();
    }
    // v1 → v2: attributed append log. Existing rows keep their write order and are attributed to "legacy". The v1
    // UNIQUE(s,p,o) index goes: re-asserting an older value must append (and become current), not be swallowed.
    if (version < 2) {
      mg.db.transaction(() => {
        const cols = columns();
        if (!cols.includes("written_at"))
          mg.db.exec("ALTER TABLE triples ADD COLUMN written_at TEXT");
        if (!cols.includes("origin")) mg.db.exec("ALTER TABLE triples ADD COLUMN origin TEXT");
        mg.db.exec(`UPDATE triples SET origin = '${JSON.stringify({ source: "legacy" })}' WHERE origin IS NULL;
                    DROP INDEX IF EXISTS u_triple;`);
        mg.db.pragma("user_version = 2");
      })();
    }
    // v2 → v3: write order is an explicit monotonic seq, not rowid (which VACUUM may renumber on a table without an
    // INTEGER PRIMARY KEY). Seeded from rowid, the order rows were written in. The current view also changed (text
    // and a relation under one key no longer shadow each other), so the search index is rebuilt.
    if (version < 3) {
      mg.db.transaction(() => {
        if (!columns().includes("seq")) mg.db.exec("ALTER TABLE triples ADD COLUMN seq INTEGER");
        mg.db.exec("UPDATE triples SET seq = rowid WHERE seq IS NULL;");
        mg.db.pragma("user_version = 3");
      })();
    }
    mg.db.exec(`CREATE INDEX IF NOT EXISTS i_sps ON triples(s, p, seq);
                CREATE INDEX IF NOT EXISTS i_seq ON triples(seq);
                CREATE INDEX IF NOT EXISTS i_origin ON triples(origin);`);
    mg.#prepare();
    if (version < 3)
      mg.db.transaction(() => {
        mg.db.exec("DELETE FROM lit_fts");
        for (const { s } of mg.db.prepare("SELECT DISTINCT s FROM triples").all() as {
          s: string;
        }[])
          mg.#reindex(s);
      })();
    // Ontology persists in the same durable store (meta table), grown by extendSchema.
    // The ontology is regenerated from one canonical definition per record type (meta 'schema_defs') plus any raw
    // shapes, so extending an existing type MERGES into its definition instead of appending a second shape (which
    // duplicated requirements, e.g. "phone, company, phone, company, …"). Older stores held only the appended text;
    // their definitions are derived once from the parsed shapes, which also collapses existing duplicates.
    const meta = (k: string) =>
      (mg.db.prepare("SELECT value FROM meta WHERE key=?").get(k) as { value: string } | undefined)
        ?.value;
    const legacyTtl = meta("ontology") ?? PREFIXES;
    const savedDefs = meta("schema_defs");
    if (savedDefs != null) {
      mg.#schemaDefs = JSON.parse(savedDefs);
      mg.#rawTtl = meta("raw_ttl") ?? "";
    } else
      ({ defs: mg.#schemaDefs, rawTtl: mg.#rawTtl } = deriveDefs(
        await parseTurtle(legacyTtl),
        legacyTtl,
      ));
    mg.#ontologyTtl = renderOntology(mg.#schemaDefs, mg.#rawTtl);
    mg.#metaValidator = new SHACLValidator(await parseTurtle(SHACL_SHACL_TTL), { factory: rdf });
    await mg.#reparseShapes();
    return mg;
  }

  #prepare() {
    this.#ins = this.db.prepare(`INSERT INTO triples(s,p,o,ot,dt,written_at,origin,seq)
                                 VALUES (?,?,?,?,?,?,?,(SELECT ifnull(max(seq), 0) + 1 FROM triples))`);
    this.#insF = this.db.prepare("INSERT INTO lit_fts(s,o) VALUES (?,?)");
    this.#delF = this.db.prepare("DELETE FROM lit_fts WHERE s=?");
    // Current view: type, label and attributes are one value per key and the latest write wins; relations are
    // edges and accumulate. Each kind resolves only against rows of its own kind — text and a relation under the same
    // key are different facts and never shadow each other. Superseded rows stay in the log but never reach a read.
    this.#current =
      this.db.prepare(`SELECT s,p,o,ot,dt,origin FROM triples t WHERE s=? AND ${SINGLE_VALUED}
                                     AND seq = (SELECT max(seq) FROM triples WHERE s=t.s AND p=t.p AND ${SINGLE_VALUED}) AND ot != 'tomb'`);
    this.#relations =
      this.db.prepare(`SELECT s,p,o,ot,dt,origin FROM triples t WHERE s=? AND ${EDGE}
                                       AND seq = (SELECT max(seq) FROM triples WHERE s=t.s AND p=t.p AND o=t.o AND ${EDGE}) AND ot = 'iri'`);
    this.#currentOfType = this.db.prepare(`SELECT s FROM triples t WHERE p='${TYPE}' AND o=?
                                           AND seq = (SELECT max(seq) FROM triples WHERE s=t.s AND p=t.p) LIMIT ?`);
  }

  // The current state of one entity, from the log.
  #view(s: string): View {
    const single = this.#current.all(s);
    const relations = this.#relations.all(s);
    const attributes: Record<string, string> = {};
    // Values the agent wrote while handling content it was handed (an email, a document) rather than stated by the
    // user: key → where they came from. Reads surface this so a filed claim is never mistaken for the user's own fact.
    const filed: Record<string, string> = {};
    // The same, once the person approved the value: still from the content, but no longer an unconfirmed claim.
    const approved: Record<string, string> = {};
    const note = (key: string, row: StoredTriple) => {
      let o: { from?: string; provenance?: string } | null = null;
      try {
        o = JSON.parse(row.origin ?? "null");
      } catch {
        return;
      }
      const from = o?.from || "content you were handed";
      if (o?.provenance === "content") filed[key] = from;
      else if (o?.provenance === "content-approved") approved[key] = from;
    };
    let type: string | undefined, label: string | undefined;
    for (const r of single) {
      const key = keyOf(r.p);
      if (r.p === TYPE) type = tail(r.o);
      else if (r.p === LABEL) label = r.o;
      else if (r.ot === "lit" && r.p.startsWith(P)) attributes[key] = r.o;
      note(key, r);
    }
    for (const r of relations) note(`${tail(r.p)}→${tail(r.o)}`, r);
    return {
      exists: single.length + relations.length > 0,
      type,
      label,
      attributes,
      relations: relations.map(withoutOrigin),
      rows: [...single, ...relations].map(withoutOrigin),
      filed,
      approved,
    };
  }
  // The search index serves the current view only — a superseded value must not be findable as if it were true.
  #reindex(s: string) {
    this.#delF.run(s);
    for (const r of this.#current.all(s)) if (r.ot === "lit") this.#insF.run(s, r.o);
  }

  async #reparseShapes() {
    this.#shapes = await parseTurtle(this.#ontologyTtl);
    this.#dataValidator = new SHACLValidator(this.#shapes, { factory: rdf });
    this.#shapeIndex = indexShapes(this.#shapes);
  }
  /** Every active authored rule — bounded by construction (personal scale: a handful). */
  shapeIndex(): ShapeEntry[] {
    return this.#shapeIndex;
  }
  #saveOntology() {
    const put = this.db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)");
    this.db.transaction(() => {
      put.run("schema_defs", JSON.stringify(this.#schemaDefs));
      put.run("raw_ttl", this.#rawTtl);
      put.run("ontology", this.#ontologyTtl);
    })();
  }
  close(): void {
    this.db.close();
  }

  // Data-validation problems rendered from the report's structure (constraint, field, expected datatype, value) —
  // never from a rule author's free-text sh:message, which would otherwise reach the model verbatim: a canary with an
  // instruction-shaped message was followed on the rejection path. Meta-validation keeps SHACL-SHACL's own messages.
  #dataProblems(
    report: Report,
    typeOf: (focus: string | undefined) => string | undefined,
  ): Problem[] {
    const DT_NAME: Record<string, string> = {
      integer: "a whole number",
      decimal: "a number",
      boolean: "true or false",
      date: "a date",
      string: "text",
    };
    return report.results.map((r) => {
      const field = r.path?.value?.split(/[#/]/).pop() ?? "a field";
      const on = (p: string) =>
        r.sourceShape
          ? [...this.#shapes.match(r.sourceShape, rdf.namedNode(SH + p), null)][0]?.object.value
          : undefined;
      const kind = typeOf(r.focusNode?.value);
      const who = kind ? `\`${kind}\` records` : "This record";
      const constraint = r.sourceConstraintComponent?.value?.split(/[#/]/).pop();
      const got = r.value?.value != null ? ` (got "${String(r.value.value).slice(0, 60)}")` : "";
      const byConstraint: Record<string, string> = {
        MinCountConstraintComponent: `${who} require \`${field}\`.`,
        MaxCountConstraintComponent: `${who} allow at most ${on("maxCount")} \`${field}\`.`,
        DatatypeConstraintComponent: `${who}: \`${field}\` must be ${DT_NAME[on("datatype")?.split("#").pop() ?? ""] ?? "the declared type"}${got}.`,
        NodeKindConstraintComponent: `${who}: \`${field}\` must connect to another remembered thing (by its id)${got}.`,
      };
      const message =
        (constraint && byConstraint[constraint]) ||
        `${who}: \`${field}\` fails the ${constraint?.replace("ConstraintComponent", "") ?? "validation"} check${got}.`;
      return {
        focus: r.focusNode?.value,
        path: r.path?.value,
        constraint,
        value: r.value?.value,
        message,
      };
    });
  }

  // ---- extend_schema: author a class/shape; gated first by the naming lint, then meta-validation vs SHACL-SHACL ----
  async extendSchema(def: ExtendInput): Promise<ExtendResult> {
    if (def.rawShape) {
      let ds: Dataset;
      try {
        ds = await parseTurtle(PREFIXES + def.rawShape);
      } catch (e) {
        return {
          ok: false,
          stage: "meta-validation",
          problems: [{ message: `Not valid RDF: ${e instanceof Error ? e.message : String(e)}` }],
        };
      }
      const rep = await this.#metaValidator.validate(ds);
      if (!rep.conforms) {
        dlog(
          "extend_schema REJECTED (raw, meta-validation):",
          reportProblems(rep)
            .map((p) => p.message)
            .join(" | "),
        );
        return { ok: false, stage: "meta-validation", problems: reportProblems(rep) };
      }
      this.#rawTtl += `\n${def.rawShape}\n`;
      this.#ontologyTtl = renderOntology(this.#schemaDefs, this.#rawTtl);
      await this.#reparseShapes();
      this.#saveOntology();
      dlog("extend_schema ACCEPTED (raw shape) — ontology grown");
      return { ok: true, class: "raw" };
    }
    const cls = pascal(def.class);
    // Kind and field names are replayed to the model every turn, so they must stay names: short noun phrases.
    // A long, sentence-like name is an instruction-shaped payload (a canary type name was obeyed) — lint it out here.
    const naming = nameProblems([
      ["kind", String(def.class), cls],
      ...(def.requires ?? []).map((r): [string, string, string] => [
        "detail",
        r.slot,
        slug(r.slot),
      ]),
      ...(def.relations ?? []).map((r): [string, string, string] => [
        "connection",
        r.relation,
        slug(r.relation),
      ]),
    ]);
    if (naming.length) {
      dlog("extend_schema REJECTED (naming):", naming.map((p) => p.message).join(" | "));
      return { ok: false, stage: "naming", problems: naming };
    }
    const merged = mergeDef(this.#schemaDefs[cls], def);
    const shape = shapeTtl(cls, merged);
    const report = await this.#metaValidator.validate(await parseTurtle(PREFIXES + shape));
    if (!report.conforms) {
      dlog(
        "extend_schema REJECTED (meta-validation):",
        cls,
        reportProblems(report)
          .map((p) => p.message)
          .join(" | "),
      );
      return { ok: false, stage: "meta-validation", problems: reportProblems(report) };
    }
    const existed = cls in this.#schemaDefs;
    this.#schemaDefs = { ...this.#schemaDefs, [cls]: merged };
    this.#ontologyTtl = renderOntology(this.#schemaDefs, this.#rawTtl);
    await this.#reparseShapes();
    this.#saveOntology();
    dlog(
      "extend_schema ACCEPTED:",
      cls,
      existed ? "(merged into the existing definition)" : "(new)",
      `(${Object.keys(merged.requires).length} detail(s), ${Object.keys(merged.relations).length} connection(s))`,
    );
    return {
      ok: true,
      class: cls,
      merged: existed,
      rule: this.#shapeIndex.find((x) => x.class === cls)?.summary ?? cls,
    };
  }

  // ---- remember: set the given keys on an entity (new or existing), lint the resulting entity, append ----
  // Saving an existing id sets exactly the keys it supplies — the tool's input is one value per key, so a
  // re-save means "this is now the value". Nothing is overwritten: the prior value stays in the log, attributed.
  async remember(fact: RememberInput, origin: string = DIRECT): Promise<RememberResult> {
    const naming = nameProblems([
      ...(fact.type ? [["type", fact.type, pascal(fact.type)] as [string, string, string]] : []),
      ...Object.keys(fact.attributes ?? {}).map((k): [string, string, string] => [
        "detail",
        k,
        slug(k),
      ]),
      ...(fact.relations ?? []).map((r): [string, string, string] => [
        "connection",
        r.relation,
        slug(r.relation),
      ]),
    ]);
    if (naming.length) {
      dlog("remember REJECTED (naming):", naming.map((p) => p.message).join(" | "));
      return { ok: false, stage: "naming", problems: naming };
    }
    const held = fact.id ? undefined : this.#holding(fact);
    const id = fact.id
      ? slug(fact.id)
      : held
        ? tail(held)
        : this.#freshId(fact.label ?? fact.type ?? "thing");
    const s = `${E}${id}`;
    const before = this.#view(s);
    const want: Triple[] = [];
    if (fact.type || !before.exists)
      want.push({ s, p: TYPE, o: `${C}${pascal(fact.type ?? "Thing")}`, ot: "iri", dt: null });
    if (fact.label)
      want.push({ s, p: LABEL, o: String(fact.label), ot: "lit", dt: `${XSD}string` });
    for (const [k, v] of Object.entries(fact.attributes ?? {}))
      want.push({ s, p: `${P}${slug(k)}`, o: String(v), ot: "lit", dt: xsdOf(v) });
    const relations: Triple[] = (fact.relations ?? []).map((r) => ({
      s,
      p: `${P}${slug(r.relation)}`,
      o: `${E}${slug(r.to)}`,
      ot: "iri",
      dt: null,
    }));

    // The entity as it would stand after this write: current values, with the supplied keys replaced.
    const byKey = new Map(before.rows.filter((r) => !isRelation(r.p, r.ot)).map((r) => [r.p, r]));
    for (const w of want) byKey.set(w.p, w);
    const relKey = (r: Triple) => `${r.p} ${r.o}`;
    const rels = new Map(
      before.rows.filter((r) => isRelation(r.p, r.ot)).map((r) => [relKey(r), r]),
    );
    for (const r of relations) rels.set(relKey(r), r);
    const after = [...byKey.values(), ...rels.values()];

    // Lint the resulting entity, not just this write: a heal that supplies only the missing detail is valid.
    const report = await this.#dataValidator.validate(
      await parseTurtle(`${PREFIXES + toTtl(after)}\n`),
    );
    if (!report.conforms) {
      const typeAfterRow = after.find((r) => r.p === TYPE);
      const typeAfter = typeAfterRow ? tail(typeAfterRow.o) : undefined;
      const problems = this.#dataProblems(report, () => typeAfter);
      dlog("remember REJECTED (lint):", id, problems.map((p) => p.message).join(" | "));
      return { ok: false, stage: "lint", problems };
    }

    const current = new Map(before.rows.filter((r) => !isRelation(r.p, r.ot)).map((r) => [r.p, r]));
    const changes = want.filter((w) => {
      const c = current.get(w.p);
      return !c || c.o !== w.o || (c.dt ?? null) !== (w.dt ?? null);
    });
    const newRels = relations.filter((r) => !before.rows.some((b) => b.p === r.p && b.o === r.o));
    const superseded: Change[] = changes.flatMap((w) => {
      const c = current.get(w.p);
      return c
        ? [
            {
              key: keyOf(w.p),
              from: w.p === TYPE ? tail(c.o) : c.o,
              to: w.p === TYPE ? tail(w.o) : w.o,
            },
          ]
        : [];
    });
    if (changes.length + newRels.length > 0) {
      const at = new Date().toISOString();
      this.db.transaction(() => {
        for (const r of [...changes, ...newRels])
          this.#ins.run(r.s, r.p, r.o, r.ot, r.dt ?? null, at, origin);
        this.#reindex(s);
      })();
    }
    const view = this.#view(s);
    dlog(
      "remember COMMITTED to store:",
      id,
      `(${view.type})`,
      JSON.stringify(fact.attributes ?? {}),
      `source=${provenanceOf(origin)}`,
      superseded.length ? `superseded ${JSON.stringify(superseded)}` : "",
    );
    // Surface the id: the model needs it to connect other things to this one (relations resolve by id, so a
    // relation to a bare label would dangle to a non-existent node).
    let summary = `${before.exists ? "Updated" : "Remembered"} ${view.label ?? id} (${view.type}) [id: ${id}]. Use this id to connect other things to it.`;
    if (superseded.length)
      summary += ` Replaced: ${superseded.map((c) => `${c.key} "${c.from}" → "${c.to}"`).join("; ")} (earlier values are kept in history).`;
    // Loud, never blocking: a rule binds by type, so a save under another type silently dodges it. Say so.
    const skipped = this.#shapeIndex.filter((r) => r.class !== view.type);
    if (skipped.length) {
      const shown = skipped.slice(0, 3).map((r) => r.summary);
      if (skipped.length > 3) shown.push(`+${skipped.length - 3} more`);
      summary += ` Saved as ${view.type}, so it was NOT checked against your other rules: ${shown.join("; ")}. If it is one of those kinds, save it with that type.`;
    }
    return { ok: true, id, summary, superseded };
  }

  // ---- forget: retract a whole entity, or some of its details. Appends attributed tombstones — the current
  // view drops them, history keeps what was forgotten, and revertBatch can undo it. Re-remembering starts fresh.
  async forget(
    { id, details }: { id: string; details?: string[] },
    origin: string = DIRECT,
  ): Promise<ForgetResult> {
    const s = `${E}${slug(id)}`;
    const before = this.#view(s);
    if (!before.exists) return { ok: false, reason: `Nothing remembered with id "${id}".` };
    // An empty list is a mistake, not a request to forget everything: whole-entity forget is only when details is omitted.
    if (Array.isArray(details) && details.length === 0)
      return {
        ok: false,
        reason:
          "No details were named. To forget the whole thing, leave details out; to forget specific details, name them.",
      };
    const wanted = details ? new Set(details.map((d) => slug(d))) : null;
    const rows = before.rows.filter((r) => !wanted || wanted.has(slug(keyOf(r.p))));
    if (rows.length === 0)
      return {
        ok: false,
        reason: `"${before.label ?? id}" has none of those details: ${(details ?? []).join(", ")}.`,
      };
    const at = new Date().toISOString();
    this.db.transaction(() => {
      for (const r of rows)
        this.#ins.run(
          s,
          r.p,
          isRelation(r.p, r.ot) ? r.o : "",
          isRelation(r.p, r.ot) ? "tomb-edge" : "tomb",
          null,
          at,
          origin,
        );
      this.#reindex(s);
    })();
    const forgotten = [...new Set(rows.map((r) => keyOf(r.p)))];
    dlog(
      "forget:",
      slug(id),
      wanted ? forgotten.join(", ") : "(whole entity)",
      `source=${provenanceOf(origin)}`,
    );
    // Loud, never blocking: forgetting a detail a rule requires leaves the entity out of conformance — say so now
    // rather than leaving it as drift for check_memory to find later.
    let breaks: string[] = [];
    if (wanted) {
      const after = this.#view(s);
      const report = await this.#dataValidator.validate(
        await parseTurtle(`${PREFIXES + toTtl(after.rows)}\n`),
      );
      if (!report.conforms)
        breaks = this.#dataProblems(report, () => after.type).map((p) => p.message);
    }
    // Forgetting the type takes the record out of rule coverage entirely (an untyped node matches no targetClass), so
    // it can never be reported as breaking anything — name the coverage it lost instead of returning a clean result.
    const lostCoverage =
      wanted && forgotten.includes("type") && before.type
        ? {
            from: before.type,
            rules: this.#shapeIndex.filter((r) => r.class === before.type).map((r) => r.summary),
          }
        : null;
    return { ok: true, label: before.label ?? id, whole: !wanted, forgotten, breaks, lostCoverage };
  }

  // A new record's id: its name plus a suffix no record holds yet. A clash would silently write into another record.
  #freshId(name: string): string {
    for (;;) {
      const id = `${slug(name)}_${Math.random().toString(36).slice(2, 6).padEnd(4, "0")}`;
      if (!this.#view(`${E}${id}`).exists) return id;
    }
  }

  // Records whose current name is the same name as `label`. Candidates share a full word with it in the current view;
  // bounded, since this runs on every write.
  #namesakes(label: string): string[] {
    const words = nameTokens(label).filter((t) => t.length > 1);
    if (words.length === 0) return [];
    const candidates = this.db
      .prepare("SELECT DISTINCT s FROM lit_fts WHERE o MATCH ? LIMIT 50")
      .all(words.map((t) => `"${t}"`).join(" OR ")) as { s: string }[];
    return candidates
      .map((r) => r.s)
      .filter((sub) => {
        const existing = this.#view(sub).label;
        return existing !== undefined && sameName(existing, label);
      });
  }

  // The record that already holds everything this id-less save says, if one does. eve re-runs a step that was
  // interrupted mid-write, so a save can arrive twice; converging on the record that holds it keeps one copy. Only an
  // exact match qualifies, so a replay can never undo a later change, and different content gets its own record.
  #holding(fact: Partial<RememberInput>): string | undefined {
    if (!fact.label) return undefined;
    const label = String(fact.label);
    return this.#namesakes(label).find((sub) => {
      const v = this.#view(sub);
      return (
        v.label === label &&
        (!fact.type || v.type === pascal(fact.type)) &&
        Object.entries(fact.attributes ?? {}).every(
          ([k, val]) => v.attributes[slug(k)] === String(val),
        ) &&
        (fact.relations ?? []).every((r) =>
          v.relations.some((b) => b.p === `${P}${slug(r.relation)}` && b.o === `${E}${slug(r.to)}`),
        )
      );
    });
  }

  /** Keys whose existing current value this remember would replace (label, type, attributes) — for approval policy. */
  previewSupersession(fact: Partial<RememberInput>): Change[] {
    const before = fact?.id ? this.#view(`${E}${slug(fact.id)}`) : undefined;
    if (!before?.exists) {
      // A new entity — but one carrying the name of an existing entity is a second, competing record of the same thing
      // (e.g. a "J. Lee" holding a different phone). Treat that as replacing the existing one, so the same gate applies,
      // whether the write gives no id or a fresh one.
      if (!fact?.label) return [];
      const label = String(fact.label);
      // Content a record already holds replaces nothing: remember converges to that record.
      if (!fact.id && this.#holding(fact)) return [];
      const twin = this.#namesakes(label)[0];
      if (twin) dlog("preview: a second record", JSON.stringify(label), "→ twin of", tail(twin));
      return twin ? [{ key: "record", from: tail(twin), to: `a second "${label}"` }] : [];
    }
    const out: Change[] = [];
    if (fact.type && before.type && pascal(fact.type) !== before.type)
      out.push({ key: "type", from: before.type, to: pascal(fact.type) });
    if (fact.label && before.label && String(fact.label) !== before.label)
      out.push({ key: "label", from: before.label, to: String(fact.label) });
    for (const [k, v] of Object.entries(fact.attributes ?? {})) {
      const cur = before.attributes[slug(k)];
      if (cur !== undefined && cur !== String(v))
        out.push({ key: slug(k), from: cur, to: String(v) });
    }
    if (out.length) dlog("preview: replaces on", slug(fact.id), JSON.stringify(out));
    return out;
  }

  // ---- recall: "what do I know about X" — FTS5 over current literal values (indexed, bounded) ----
  recall(query: string, limit = 8): Fact[] {
    const match = ftsQuery(query);
    if (match === null) {
      dlog("recall from store:", JSON.stringify(query), "→ (no searchable tokens)");
      return [];
    }
    const rows = this.db
      .prepare("SELECT s FROM lit_fts WHERE o MATCH ? ORDER BY rank LIMIT ?")
      .all(match, limit) as { s: string }[];
    const subjects = [...new Set(rows.map((r) => r.s))]; // dedup, keep rank order
    dlog(
      "recall from store:",
      JSON.stringify(query),
      "MATCH",
      JSON.stringify(match),
      "→",
      subjects.length,
      "hit(s)",
    );
    return subjects.map((s) => {
      const v = this.#view(s);
      return {
        id: tail(s),
        label: v.label,
        type: v.type,
        attributes: v.attributes,
        filed: v.filed,
        approved: v.approved,
      };
    });
  }

  // ---- check: revalidate stored entities against the active rules (self-healing) ----
  // Same validator, run over the current view of exactly the focus nodes the rules select (entities whose current
  // type is a targeted class) — verdict-identical to a whole-store run for sh:targetClass shapes, without
  // materializing the whole graph in RAM. Catches drift: entities saved before a rule existed.
  async check({
    maxEntities = 1000,
    maxIssues = 25,
  }: {
    maxEntities?: number;
    maxIssues?: number;
  } = {}): Promise<CheckResult> {
    const rules = this.#shapeIndex;
    if (rules.length === 0) return { rules: 0, checked: 0, issues: [], truncated: false };
    const subjects = new Set<string>();
    for (const r of rules)
      for (const row of this.#currentOfType.all(r.classIri, maxEntities + 1)) subjects.add(row.s);
    const truncated = subjects.size > maxEntities;
    const focus = [...subjects].slice(0, maxEntities);
    const views = new Map(focus.map((s) => [s, this.#view(s)]));
    const report = await this.#dataValidator.validate(
      await parseTurtle(`${PREFIXES + toTtl([...views.values()].flatMap((v) => v.rows))}\n`),
    );
    const grouped = new Map<string, string[]>();
    for (const p of this.#dataProblems(report, (focus) =>
      focus === undefined ? undefined : views.get(focus)?.type,
    )) {
      if (p.focus === undefined) continue;
      if (!grouped.has(p.focus)) grouped.set(p.focus, []);
      grouped.get(p.focus)?.push(p.message);
    }
    const issues = [...grouped].slice(0, maxIssues).map(([s, messages]) => ({
      id: tail(s),
      label: views.get(s)?.label,
      type: views.get(s)?.type,
      messages,
    }));
    dlog(
      "check:",
      focus.length,
      "entities against",
      rules.length,
      "rule(s) →",
      grouped.size,
      "with issues",
    );
    return {
      rules: rules.length,
      checked: focus.length,
      issues,
      truncated: truncated || grouped.size > maxIssues,
    };
  }

  // ---- relate: "what's connected to Y" — the focus entity's current state plus its relation edges ----
  relate(about: string, limit = 12): RelateResult {
    const match = ftsQuery(about);
    if (match === null) {
      dlog("relate:", JSON.stringify(about), "→ (no searchable tokens)");
      return { found: false, connections: [] };
    }
    const hit = this.db
      .prepare("SELECT s FROM lit_fts WHERE o MATCH ? ORDER BY rank LIMIT 1")
      .get(match) as { s: string } | undefined;
    if (hit === undefined) {
      dlog("relate:", JSON.stringify(about), "→ not found");
      return { found: false, connections: [] };
    }
    const v = this.#view(hit.s);
    const connections = v.relations
      .slice(0, limit)
      .map((r) => ({ relation: tail(r.p), target: this.#view(r.o).label ?? tail(r.o) }));
    dlog(
      "relate:",
      JSON.stringify(about),
      "→",
      tail(hit.s),
      "has",
      connections.length,
      "connection(s)",
    );
    // Entity-scoped: return the focus entity's full attributes alongside its connections — the on-demand detail path.
    return {
      found: true,
      entity: tail(hit.s),
      label: v.label,
      type: v.type,
      attributes: v.attributes,
      filed: v.filed,
      approved: v.approved,
      connections,
    };
  }

  /** The current state of one entity (what reads serve), or null if nothing current is remembered under the id. */
  describe(id: string): Description | null {
    const v = this.#view(`${E}${slug(id)}`);
    return v.exists
      ? {
          id: slug(id),
          label: v.label,
          type: v.type,
          attributes: v.attributes,
          relations: v.relations.map((r) => ({ relation: tail(r.p), to: tail(r.o) })),
          filed: v.filed,
          approved: v.approved,
        }
      : null;
  }

  // ---- operator surface: every write is attributed, so any value's history is inspectable and a batch revertible ----
  history(id: string): HistoryEntry[] {
    return (
      this.db
        .prepare("SELECT p, o, written_at, origin FROM triples WHERE s=? ORDER BY seq")
        .all(`${E}${slug(id)}`) as {
        p: string;
        o: string;
        written_at: string | null;
        origin: string | null;
      }[]
    ).map((r) => ({
      key: keyOf(r.p),
      value: r.p === TYPE ? tail(r.o) : r.o,
      writtenAt: r.written_at,
      origin: JSON.parse(r.origin ?? "null"),
    }));
  }
  /**
   * Records that a tool call paused for the person's approval, with a fingerprint of the input they were shown. Kept
   * in the store, not in memory, so it survives a restart between the pause and the resume.
   */
  holdApproval(callId: string, shown: unknown): void {
    this.db
      .prepare("INSERT OR REPLACE INTO held_approvals(call_id, fingerprint) VALUES (?, ?)")
      .run(callId, fingerprint(shown));
  }
  /**
   * Whether this call paused for approval of exactly this input, consumed once. A call that never paused, or that
   * runs with any input other than the one the person was shown, is not approved.
   *
   * eve itself guarantees the second part: on approval it runs the tool call already in the transcript, and the
   * approval response carries no input. The comparison is defense in depth for a provider driven directly or embedded
   * outside eve's loop, where nothing else binds what executes to what was approved.
   */
  takeApproval(callId: string | undefined, input: unknown): boolean {
    if (!callId) return false;
    const held = this.db
      .prepare("SELECT fingerprint FROM held_approvals WHERE call_id = ?")
      .get(callId) as { fingerprint: string } | undefined;
    if (held?.fingerprint !== fingerprint(input)) return false;
    this.db.prepare("DELETE FROM held_approvals WHERE call_id = ?").run(callId);
    return true;
  }

  /** Drop every row one origin wrote (match on any of its fields, e.g. { callId } or { sessionId }); reads fall back. */
  revertBatch(match: Record<string, string | number>): {
    removed: number;
    entities: string[];
    untyped: string[];
  } {
    const keys = Object.keys(match);
    if (keys.length === 0) throw new Error("revertBatch needs at least one origin field to match");
    const where = keys
      .map((k) => `json_extract(origin, '$.${k.replace(/[^a-zA-Z]/g, "")}') = ?`)
      .join(" AND ");
    return this.db.transaction(() => {
      const affected = (
        this.db
          .prepare(`SELECT DISTINCT s FROM triples WHERE ${where}`)
          .all(...keys.map((k) => match[k])) as { s: string }[]
      ).map((r) => r.s);
      const removed = this.db
        .prepare(`DELETE FROM triples WHERE ${where}`)
        .run(...keys.map((k) => match[k])).changes;
      for (const s of affected) this.#reindex(s);
      // A batch that wrote only an entity's type leaves its other details behind with no type: still readable, but
      // outside every rule. Report them so the operator can re-type or revert further.
      const untyped = affected
        .filter((s) => {
          const v = this.#view(s);
          return v.exists && !v.type;
        })
        .map(tail);
      dlog(
        "revertBatch:",
        JSON.stringify(match),
        "→",
        removed,
        "row(s) across",
        affected.length,
        "entit(ies)",
        untyped.length ? `untyped: ${untyped.join(", ")}` : "",
      );
      return { removed, entities: affected.map(tail), untyped };
    })();
  }
}
