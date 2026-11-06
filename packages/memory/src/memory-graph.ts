// @eve-plus/memory — core adapter. STORE: better-sqlite3 (triples table + FTS5), disk-backed, bounded machine
// RAM, natively crash-safe (WAL). ONTOLOGY/VALIDATION: SHACL over rdf-validate-shacl. The agent never sees
// RDF/SQL: it calls remember/recall/relate/extendSchema with plain JSON; this maps NL↔RDF/SQL internally.
// "The only gate is does it lint." (Store chosen mechanically — bake-off: SQLite bounds RAM where
// quadstore+comunica inflated it +1GB@100k.)

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
  /** The record's handle, if it has one. A record saved before 0.6.0 has none until it is migrated. */
  handle?: string;
  label?: string;
  type?: string;
  attributes?: Record<string, string>;
  /** Who wrote each current detail, and when (detail → origin), from the write's recorded origin. */
  recorded?: Record<string, Recorded>;
  /** Who gave the record its current name, and when. */
  recordedName?: Recorded;
  /** Who gave the record its current type, and when. */
  recordedType?: Recorded;
}
export interface RelateResult {
  found: boolean;
  entity?: string;
  handle?: string;
  label?: string;
  type?: string;
  attributes?: Record<string, string>;
  recorded?: Record<string, Recorded>;
  recordedName?: Recorded;
  recordedType?: Recorded;
  connections: { relation: string; target: string; id: string; handle?: string }[];
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
  issues: { id: string; handle?: string; label?: string; type?: string; messages: string[] }[];
  truncated: boolean;
}
/** The record that already holds a handle, and how: as its current handle, an earlier one, a forgotten record's, a
 * record's internal id, or the name of a record saved before handles that hasn't been given one yet. */
export interface Holder {
  id: string;
  handle?: string;
  label?: string;
  type?: string;
  holds: "current" | "earlier" | "forgotten" | "id" | "unmigrated";
}
export type RememberResult =
  | Ok<{ id: string; handle?: string; summary: string; superseded: Change[]; replayed?: boolean }>
  | (Fail & { holder?: Holder });
/**
 * What a reference names. `found` follows "merged into"; `forgotten` is a record that was forgotten (its handle stays
 * reserved, so a reference never lands on a newer thing); `missing` carries the nearest handles.
 */
export type Resolution =
  | {
      status: "found";
      id: string;
      handle?: string;
      via: "handle" | "earlier" | "id";
      mergedFrom?: string[];
    }
  | { status: "forgotten"; id: string; handle?: string; on: string | null }
  | { status: "missing"; suggestions: string[] };
export type HandleResult =
  | { ok: true; handle: string }
  | { ok: false; reason: string; holder?: Holder };
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
  handle?: string;
  label?: string;
  type?: string;
  attributes: Record<string, string>;
  relations: { relation: string; to: string }[];
  recorded: Record<string, Recorded>;
  recordedName?: Recorded;
  recordedType?: Recorded;
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
type StoredTriple = Triple & { origin: string | null; written_at: string | null };
/**
 * Who wrote a value, from its recorded origin: in the scope owner's own live conversation, another principal's, a
 * scheduled run, a delegated task, an unattributed write, or a store from before writes were attributed ("legacy").
 * Recorded at write time; nothing is decided from what the model says about a write.
 */
export type Who = "owner" | "other" | "scheduled" | "delegated" | "unattributed" | "legacy";
export interface Recorded {
  who: Who;
  /** The write's date, YYYY-MM-DD. */
  on: string | null;
}
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
  recorded: Record<string, Recorded>;
  recordedName?: Recorded;
  recordedType?: Recorded;
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

export const slug = (s: unknown) =>
  String(s)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "x";

/** How a reference to a record is written: `knowledge:<handle>`, or `knowledge:<id>` for a record without a handle. */
export const REFERENCE_PREFIX = "knowledge:";
/**
 * The longest handle, in UTF-16 code units (JavaScript string length): `knowledge:` plus a handle stays within 128,
 * well under the 512-unit cap a link has in `@eve-plus/working`.
 */
export const HANDLE_MAX = 118;
/**
 * A record's handle from its name. Django's `slugify(value, allow_unicode=True)` (django/utils/text.py at 816ea69c),
 * with two changes: combining marks are kept (Python's `\w` drops spacing marks, which breaks Devanagari and other
 * scripts), and `_` is a separator like space and `-`, so a handle has one separator. NFKC, lowercase, drop what
 * isn't a letter, mark, digit or separator, collapse separators to one `-`, trim. Letters stay in their own script:
 * "李明" is `李明`, "José García" is `josé-garcía`. Over HANDLE_MAX it is cut at the last `-` in range, or at a code
 * point when there is none. A name with no letters or digits gives "", which callers refuse.
 */
export function handleOf(label: unknown): string {
  const h = String(label)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, "")
    .replace(/[\s_-]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  if (h.length <= HANDLE_MAX) return h;
  if (h[HANDLE_MAX] === "-") return h.slice(0, HANDLE_MAX);
  let cut = h.slice(0, HANDLE_MAX);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  const dash = cut.lastIndexOf("-");
  return (dash > 0 ? cut.slice(0, dash) : cut).replace(/-+$/, "");
}
const bare = (ref: string) => {
  const r = String(ref).trim();
  return r.toLowerCase().startsWith(REFERENCE_PREFIX) ? r.slice(REFERENCE_PREFIX.length) : r;
};
// Edit distance, for "did you mean" on a miss (git's help.c ranks its suggestions the same way).
function distance(a: string, b: string): number {
  const x = [...a],
    y = [...b];
  let prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const row = [i];
    for (let j = 1; j <= y.length; j++)
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[y.length];
}
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
// FTS5 MATCH from free text: tokenize, drop 1–2 char noise (with a fallback so an all-short query still runs),
// quote each token, OR-join. A single quoted phrase would require the whole string to appear adjacent+in-order —
// so a multi-word query could never match a stored literal. OR over tokens is the "any word matches" recall we want.
// Words are letters, marks and digits in any script, NFKC-normalised as handles are; the index's own tokenizer
// (unicode61, diacritics removed) folds case and accents on both sides, so "Zoë" and "zoe" both find "Zoë". One- and
// two-character words are noise in alphabetic scripts, accented or not: the index folds "à" and "où" to the "a" and
// "ou" the rule drops. In Han, kana and Hangul one character can be a word, so "李明" is a whole name.
const IDEOGRAPHIC = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const ftsQuery = (s: string) => {
  const tokens =
    String(s)
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{M}\p{N}]+/gu) || [];
  const use = tokens.filter((t) => t.length >= 3 || IDEOGRAPHIC.test(t));
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
const parseOrigin = (origin: string | null): Record<string, unknown> | null => {
  try {
    return JSON.parse(origin ?? "null");
  } catch {
    return null;
  }
};
/**
 * Who wrote a row. 0.3 records `who`. 0.2.x grounded its "user" provenance the same way (a live turn by the scope's
 * own principal, marked by its `claimed` field) and flagged scheduled and delegated writes. A write through this
 * class's API without a provider origin is the operator's own code. Anything else can't be told apart: "legacy".
 */
export function whoOf(origin: string | null): Who {
  const o = parseOrigin(origin);
  if (typeof o?.who === "string") return o.who as Who;
  if (o?.provenance === "user" && "claimed" in o) return "owner";
  if (o?.scheduled === true) return "scheduled";
  if (o?.delegated === true) return "delegated";
  if (o?.source === "direct") return "owner";
  return "legacy";
}
// Whether a row puts a type or a record's type under the owner's control: written in the owner's own conversation, or
// written before 0.3.0 (no recorded `who`) by anything but a scheduled run or delegated task. Older stores' types came
// from the owner's conversations, and only 0.2.x recorded which writes were scheduled or delegated.
const ownerControlled = (origin: string | null): boolean => {
  const who = whoOf(origin);
  return who === "owner" || (parseOrigin(origin)?.who === undefined && who === "legacy");
};
// Whether the scope a write lands in has an owner to protect. A scope that isn't one principal's (a list, a shared
// key) has none, so the control-plane rule doesn't apply there.
const hasOwner = (origin: string): boolean => parseOrigin(origin)?.ownedScope !== false;
const onOf = (writtenAt: string | null) => (writtenAt ? writtenAt.slice(0, 10) : null);
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
// The current view in SQL, shared with the read-only stats (stats.ts) so the two can't drift. A single-valued key's
// latest write wins; an edge is current while its latest write isn't a tombstone.
const LATEST_SINGLE = `seq = (SELECT max(seq) FROM triples WHERE s=t.s AND p=t.p AND ${SINGLE_VALUED})`;
const LATEST_EDGE = `seq = (SELECT max(seq) FROM triples WHERE s=t.s AND p=t.p AND o=t.o AND ${EDGE})`;
/** Every current literal value, one row each: what the search index should hold. */
export const CURRENT_LITERALS_SQL = `SELECT s, o FROM triples t WHERE ot = 'lit' AND ${SINGLE_VALUED} AND ${LATEST_SINGLE}`;
/** How many facts are current: single-valued details plus live edges. */
export const CURRENT_FACTS_SQL = `SELECT (SELECT count(*) FROM triples t WHERE ${SINGLE_VALUED} AND ot != 'tomb' AND ${LATEST_SINGLE})
                                      + (SELECT count(*) FROM triples t WHERE ${EDGE} AND ot = 'iri' AND ${LATEST_EDGE}) AS n`;
/** How many handles are held: one live row per handle, whether current, earlier, or a forgotten record's. */
export const LIVE_HANDLES_SQL =
  "SELECT count(*) AS n FROM handles WHERE kind = 'handle' AND superseded_by IS NULL";
/** How many records are live: those with a current detail or a live connection. */
export const LIVE_RECORDS_SQL = `SELECT count(*) AS n FROM (SELECT s FROM triples t WHERE ${SINGLE_VALUED} AND ot != 'tomb' AND ${LATEST_SINGLE}
                                                         UNION SELECT s FROM triples t WHERE ${EDGE} AND ot = 'iri' AND ${LATEST_EDGE})`;
/** How many connections are live. */
export const LIVE_EDGES_SQL = `SELECT count(*) AS n FROM triples t WHERE ${EDGE} AND ot = 'iri' AND ${LATEST_EDGE}`;
/** Every row in the log, tombstones included. */
export const TRIPLES_SQL = "SELECT count(*) AS n FROM triples";
/**
 * The store's write high-water mark: the largest `seq` ever assigned. It only grows, even when `revertBatch` deletes
 * the latest rows, so a mark lower than a previous reading means the store was lost or replaced.
 */
export const SEQ_HWM_SQL = "SELECT CAST(value AS INTEGER) AS n FROM meta WHERE key = 'seq_hwm'";
const keyOf = (p: string) => (p === TYPE ? "type" : p === LABEL ? "label" : tail(p));
// Forgetting appends a tombstone rather than deleting: 'tomb' retracts a single-valued key, 'tomb-edge' one edge.
const toTtl = (rows: Triple[]) =>
  rows
    .map((t) => `<${t.s}> <${t.p}> ${t.ot === "iri" ? `<${t.o}>` : litTerm(t.o, t.dt)} .`)
    .join("\n");
const DIRECT = JSON.stringify({ source: "direct" });
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
  // Writes by a scheduled run, a delegated task or another principal that replaced or retracted a value written in the
  // owner's own conversation: counted and logged, never blocked (detection, not a gate).
  #ownerOverwrites = 0;
  // Classes a raw shape names. Raw shapes come only from the operator's own code (this API, or an older store), never
  // through the tools, so these types are the owner's.
  #rawClasses = new Set<string>();
  #ins!: (
    s: string,
    p: string,
    o: string,
    ot: string,
    dt: string | null,
    at: string,
    origin: string,
  ) => void;
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
                CREATE TABLE IF NOT EXISTS schema_log(seq INTEGER PRIMARY KEY, class TEXT, def TEXT, raw TEXT,
                                                      written_at TEXT, origin TEXT);
                CREATE TABLE IF NOT EXISTS handles(seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL,
                                                   handle TEXT, s TEXT NOT NULL, target TEXT, written_at TEXT,
                                                   origin TEXT, superseded_by INTEGER);
                CREATE UNIQUE INDEX IF NOT EXISTS u_handle ON handles(handle)
                  WHERE kind = 'handle' AND superseded_by IS NULL;
                CREATE INDEX IF NOT EXISTS i_handles_s ON handles(s);
                CREATE INDEX IF NOT EXISTS i_handles_origin ON handles(origin);
                DROP TABLE IF EXISTS held_approvals;
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
    // v3 → v4: the write high-water mark is persisted, seeded from the highest seq on disk.
    if (version < 4) {
      mg.db.transaction(() => {
        mg.db.exec(`INSERT OR IGNORE INTO meta(key, value)
                    SELECT 'seq_hwm', CAST(ifnull(max(seq), 0) AS TEXT) FROM triples;`);
        mg.db.pragma("user_version = 4");
      })();
    }
    // v4 → v5: the handles table (created above). Nothing is backfilled: a record saved before handles gets one only
    // from mintHandle, so a name two old records share is never settled on open, with nobody to decide it.
    if (version < 5) mg.db.pragma("user_version = 5");
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
    // Schema changes are an attributed append log like the triples, so revertBatch undoes them too. A store from
    // before the log seeds it once from its meta rows, attributed to "legacy".
    if (meta("schema_log_seeded") == null) {
      const legacyTtl = meta("ontology") ?? PREFIXES;
      const savedDefs = meta("schema_defs");
      const { defs, rawTtl } =
        savedDefs != null
          ? { defs: JSON.parse(savedDefs) as SchemaDefs, rawTtl: meta("raw_ttl") ?? "" }
          : deriveDefs(await parseTurtle(legacyTtl), legacyTtl);
      const legacy = JSON.stringify({ source: "legacy" });
      mg.db.transaction(() => {
        for (const [cls, def] of Object.entries(defs))
          mg.#logSchema(cls, { base: def }, null, legacy);
        if (rawTtl.trim()) mg.#logSchema(null, null, rawTtl, legacy);
        mg.db
          .prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('schema_log_seeded','1')")
          .run();
      })();
    }
    mg.#loadSchema();
    mg.#metaValidator = new SHACLValidator(await parseTurtle(SHACL_SHACL_TTL), { factory: rdf });
    await mg.#reparseShapes();
    return mg;
  }

  #prepare() {
    // A new seq is past both the mark and the highest row, so a seq freed by revertBatch is never reused, and a row an
    // older adapter wrote without moving the mark (a rollback) can't be collided with. The mark moves in the same
    // transaction as the row.
    const insert = this.db.prepare<
      [string, string, string, string, string | null, string, string],
      { seq: number }
    >(`INSERT INTO triples(s,p,o,ot,dt,written_at,origin,seq)
       VALUES (?,?,?,?,?,?,?,(SELECT max(ifnull(max(seq), 0), ifnull((${SEQ_HWM_SQL}), 0)) + 1 FROM triples))
       RETURNING seq`);
    const mark = this.db.prepare<[string]>(
      "INSERT INTO meta(key, value) VALUES ('seq_hwm', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    this.#ins = this.db.transaction(
      (
        s: string,
        p: string,
        o: string,
        ot: string,
        dt: string | null,
        at: string,
        origin: string,
      ) => {
        const { seq } = insert.get(s, p, o, ot, dt, at, origin) as { seq: number };
        mark.run(String(seq));
      },
    );
    this.#insF = this.db.prepare("INSERT INTO lit_fts(s,o) VALUES (?,?)");
    this.#delF = this.db.prepare("DELETE FROM lit_fts WHERE s=?");
    // Current view: type, label and attributes are one value per key and the latest write wins; relations are
    // edges and accumulate. Each kind resolves only against rows of its own kind — text and a relation under the same
    // key are different facts and never shadow each other. Superseded rows stay in the log but never reach a read.
    this.#current =
      this.db.prepare(`SELECT s,p,o,ot,dt,origin,written_at FROM triples t WHERE s=? AND ${SINGLE_VALUED}
                                     AND ${LATEST_SINGLE} AND ot != 'tomb'`);
    this.#relations =
      this.db.prepare(`SELECT s,p,o,ot,dt,origin,written_at FROM triples t WHERE s=? AND ${EDGE}
                                       AND ${LATEST_EDGE} AND ot = 'iri'`);
    this.#currentOfType = this.db.prepare(`SELECT s FROM triples t WHERE p='${TYPE}' AND o=?
                                           AND seq = (SELECT max(seq) FROM triples WHERE s=t.s AND p=t.p) LIMIT ?`);
  }

  // The current state of one entity, from the log.
  #view(s: string): View {
    const single = this.#current.all(s);
    const relations = this.#relations.all(s);
    const attributes: Record<string, string> = {};
    const recorded: Record<string, Recorded> = {};
    const by = (row: StoredTriple): Recorded => ({
      who: whoOf(row.origin),
      on: onOf(row.written_at),
    });
    let recordedName: Recorded | undefined, recordedType: Recorded | undefined;
    let type: string | undefined, label: string | undefined;
    for (const r of single) {
      const key = keyOf(r.p);
      if (r.p === TYPE) {
        type = tail(r.o);
        recordedType = by(r);
      } else if (r.p === LABEL) {
        label = r.o;
        recordedName = by(r);
      } else if (r.ot === "lit" && r.p.startsWith(P)) {
        attributes[key] = r.o;
        recorded[key] = by(r);
      }
    }
    for (const r of relations) recorded[`${tail(r.p)}→${tail(r.o)}`] = by(r);
    return {
      exists: single.length + relations.length > 0,
      type,
      label,
      attributes,
      relations: relations.map(withoutOrigin),
      rows: [...single, ...relations].map(withoutOrigin),
      recorded,
      recordedName,
      recordedType,
    };
  }
  // The search index serves the current view only — a superseded value must not be findable as if it were true.
  #reindex(s: string) {
    this.#delF.run(s);
    for (const r of this.#current.all(s)) if (r.ot === "lit") this.#insF.run(s, r.o);
  }

  // ---- handles: a stable id plus a unique, name-derived handle with history (Rails friendly_id's slugs table,
  // Wikipedia's titles with redirects, Kubernetes names over a UID). A handle row is live until reclaimHandle frees it;
  // the unique index allows one live row per handle, so a record's current, earlier and forgotten handles are all
  // taken. Which live row is current isn't stored: it's the one its current label makes.

  // A record's live handles, oldest first.
  #liveHandles(s: string): string[] {
    return (
      this.db
        .prepare(
          "SELECT handle FROM handles WHERE kind = 'handle' AND s = ? AND superseded_by IS NULL ORDER BY seq",
        )
        .all(s) as { handle: string }[]
    ).map((r) => r.handle);
  }
  #holderOf(handle: string): string | undefined {
    return (
      this.db
        .prepare(
          "SELECT s FROM handles WHERE kind = 'handle' AND handle = ? AND superseded_by IS NULL",
        )
        .get(handle) as { s: string } | undefined
    )?.s;
  }
  // The handle a record answers to: the live one its label makes, else its newest live one (its label was forgotten).
  #handleFor(s: string, label: string | undefined = this.#view(s).label): string | undefined {
    const live = this.#liveHandles(s);
    const named = label === undefined ? undefined : handleOf(label);
    return named !== undefined && live.includes(named) ? named : live.at(-1);
  }
  #mergedInto(s: string): string | undefined {
    return (
      this.db
        .prepare(
          "SELECT target FROM handles WHERE kind = 'merge' AND s = ? ORDER BY seq DESC LIMIT 1",
        )
        .get(s) as { target: string } | undefined
    )?.target;
  }
  /**
   * A record exactly as stored under its internal id: not resolved, merges not followed. For operator tools that
   * need to see a merged or forgotten record itself. Null for an id nothing was ever written under.
   */
  stored(id: string): {
    id: string;
    exists: boolean;
    merged: boolean;
    handles: string[];
    lastLabel?: string;
    label?: string;
    type?: string;
    attributes: Record<string, string>;
    /** Each attribute's stored datatype (xsd local name), so a copy keeps its type. */
    datatypes: Record<string, string>;
    relations: { relation: string; to: string }[];
    recorded: Record<string, Recorded>;
    /** When anything was first and last written under this id, and by whom, from every row it ever had. */
    firstWritten: string | null;
    lastWritten: string | null;
    writers: Who[];
  } | null {
    const s = `${E}${id}`;
    if (!this.#known(s)) return null;
    const v = this.#view(s);
    const log = this.db
      .prepare("SELECT written_at, origin FROM triples WHERE s = ? ORDER BY seq")
      .all(s) as { written_at: string | null; origin: string | null }[];
    return {
      id,
      exists: v.exists,
      merged: this.#mergedInto(s) !== undefined,
      handles: this.#liveHandles(s),
      lastLabel: this.#lastLabel(s),
      label: v.label,
      type: v.type,
      attributes: v.attributes,
      datatypes: Object.fromEntries(
        v.rows
          .filter((r) => r.ot === "lit" && r.p.startsWith(P))
          .map((r) => [keyOf(r.p), (r.dt ?? `${XSD}string`).slice(XSD.length)]),
      ),
      relations: v.relations.map((r) => ({ relation: tail(r.p), to: tail(r.o) })),
      recorded: v.recorded,
      firstWritten: log[0]?.written_at ?? null,
      lastWritten: log.at(-1)?.written_at ?? null,
      writers: [...new Set(log.map((r) => whoOf(r.origin)))].sort(),
    };
  }

  /** Every internal id anything was ever written under, forgotten and merged records included. */
  storedIds(): string[] {
    return (
      this.db.prepare("SELECT DISTINCT s FROM triples WHERE s LIKE ? ORDER BY s").all(`${E}%`) as {
        s: string;
      }[]
    ).map((r) => tail(r.s));
  }

  // Every row a record ever had, tombstones included: a forgotten record is still known by its id.
  #known(s: string): boolean {
    return this.db.prepare("SELECT 1 FROM triples WHERE s = ? LIMIT 1").get(s) !== undefined;
  }
  // The name a record last had, even once forgotten, for saying what a reserved handle belonged to.
  #lastLabel(s: string): string | undefined {
    return (
      this.db
        .prepare(
          `SELECT o FROM triples WHERE s = ? AND p = '${LABEL}' AND ot = 'lit' ORDER BY seq DESC LIMIT 1`,
        )
        .get(s) as { o: string } | undefined
    )?.o;
  }
  #forgottenOn(s: string): string | null {
    return onOf(
      (
        this.db
          .prepare(
            "SELECT written_at FROM triples WHERE s = ? AND ot IN ('tomb','tomb-edge') ORDER BY seq DESC LIMIT 1",
          )
          .get(s) as { written_at: string | null } | undefined
      )?.written_at ?? null,
    );
  }

  /**
   * What `ref` names, in one order everywhere: current handle, then an earlier handle, then an internal id, then the
   * handle `ref` would make as a name. An id in another case resolves as it did before handles. Takes `knowledge:<x>` or a bare `<x>`. Follows "merged into". The id step
   * matches ids exactly: `slug()` would turn "李明" into `x` and land on whatever record has id `x`. A handle is
   * unique within its scope's graph, and resolves only there.
   */
  resolve(ref: string): Resolution {
    const x = bare(ref);
    if (!x) return { status: "missing", suggestions: [] };
    let s: string | undefined;
    let via: "handle" | "earlier" | "id" = "id";
    const byHandle = (h: string) => {
      const holder = this.#holderOf(h);
      if (holder === undefined) return false;
      s = holder;
      via = this.#handleFor(holder) === h ? "handle" : "earlier";
      return true;
    };
    if (!byHandle(x)) {
      // An id as 0.5 read it too: ids were made by slug(), so a reference written in another case (`Alice_X7K2`)
      // still lands, but only for input slug() keeps intact, since it turns any other script into `x`.
      const legacy = /^[A-Za-z0-9_]+$/.test(x) ? slug(x) : undefined;
      if (this.#known(`${E}${x}`)) s = `${E}${x}`;
      else if (legacy !== undefined && this.#known(`${E}${legacy}`)) s = `${E}${legacy}`;
      else if (handleOf(x) !== x) byHandle(handleOf(x));
    }
    if (s === undefined) return { status: "missing", suggestions: this.#suggest(x) };
    const start = s;
    s = this.#followMerges(s);
    const mergedFrom = s === start ? [] : [tail(start)];
    const handle = this.#handleFor(s);
    if (!this.#view(s).exists)
      return { status: "forgotten", id: tail(s), handle, on: this.#forgottenOn(s) };
    return {
      status: "found",
      id: tail(s),
      handle,
      via,
      ...(mergedFrom.length ? { mergedFrom } : {}),
    };
  }

  // Where a stored id leads now: through "merged into", bounded and cycle-safe.
  #followMerges(s: string): string {
    const seen = new Set([s]);
    for (
      let into = this.#mergedInto(s);
      into !== undefined && !seen.has(into);
      into = this.#mergedInto(s)
    ) {
      seen.add(into);
      s = into;
      if (seen.size > 16) break;
    }
    return s;
  }

  // Nearest references to a miss: records sharing a word or a prefix with it, ranked by edit distance. Bounded.
  #suggest(x: string): string[] {
    const words = x.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);
    const subjects = new Set<string>();
    if (words.length)
      for (const r of this.db
        .prepare("SELECT DISTINCT s FROM lit_fts WHERE o MATCH ? LIMIT 50")
        .all(words.map((w) => `"${w}"`).join(" OR ")) as { s: string }[])
        subjects.add(r.s);
    for (const r of this.db
      .prepare(
        "SELECT DISTINCT s FROM handles WHERE kind = 'handle' AND superseded_by IS NULL AND handle LIKE ? ESCAPE '\\' LIMIT 200",
      )
      .all(`${([...x][0] ?? "").replace(/[\\%_]/g, "\\$&")}%`) as { s: string }[])
      subjects.add(r.s);
    return [...subjects]
      .filter((s) => this.#view(s).exists)
      .map((s) => this.#handleFor(s) ?? tail(s))
      .map((ref) => [ref, distance(ref, x)] as const)
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
      .slice(0, 3)
      .map(([ref]) => `${REFERENCE_PREFIX}${ref}`);
  }

  // Who already holds `h`, if anyone other than `self`: a live handle row (current, earlier or forgotten), a record
  // whose internal id is `h`, or a record saved before handles whose name makes `h` (detection only; nothing is
  // assigned, so a namesake is never settled without the operator).
  #holder(h: string, self?: string, { unmigrated = true } = {}): Holder | undefined {
    const describe = (s: string, holds: Holder["holds"]): Holder => {
      const v = this.#view(s);
      return {
        id: tail(s),
        handle: this.#handleFor(s, v.label),
        label: v.label ?? this.#lastLabel(s),
        type: v.type,
        holds,
      };
    };
    const live = this.#holderOf(h);
    if (live !== undefined)
      return live === self
        ? undefined
        : describe(
            live,
            !this.#view(live).exists
              ? "forgotten"
              : this.#handleFor(live) === h
                ? "current"
                : "earlier",
          );
    const byId = `${E}${h}`;
    if (byId !== self && this.#known(byId))
      return describe(byId, this.#view(byId).exists ? "id" : "forgotten");
    if (!unmigrated) return undefined;
    const rows = this.db
      .prepare(
        `SELECT s, o FROM triples t WHERE p = '${LABEL}' AND ot = 'lit' AND ${LATEST_SINGLE}
           AND s NOT IN (SELECT s FROM handles WHERE kind = 'handle' AND superseded_by IS NULL)`,
      )
      .iterate() as Iterable<{ s: string; o: string }>;
    for (const r of rows)
      if (r.s !== self && handleOf(r.o) === h) return describe(r.s, "unmigrated");
    return undefined;
  }

  #takenMessage(name: string, h: string, holder: Holder): string {
    const who = `"${holder.label ?? holder.id}"${holder.type ? ` (${holder.type})` : ""}`;
    const at = `${REFERENCE_PREFIX}${holder.handle ?? holder.id}`;
    // Past the length cap a qualifier at the end is cut off, so it would fail the same way every time.
    const qualify =
      handleOf(`${name} (Acme)`) === h
        ? `If it's a different thing, give it a shorter name, or put what tells them apart first, such as "Acme: ${name.slice(0, 40)}…", and save again.`
        : `If it's a different thing, give it a name that tells them apart, such as "${name} (Acme)", and save again.`;
    switch (holder.holds) {
      case "current":
      case "id":
        return `${who} already has the handle ${REFERENCE_PREFIX}${h}. If it's the same thing, update it: save with id "${at}". ${qualify}`;
      case "earlier":
        return `${REFERENCE_PREFIX}${h} is an earlier name of ${who}, now ${at}, and references to it still lead there. If it's the same thing, update it with id "${at}". ${qualify}`;
      case "forgotten":
        return `${REFERENCE_PREFIX}${h} belonged to ${who}, which was forgotten; references to it still say so, so the name stays reserved. ${qualify} Or ask the memory's operator to reclaim the handle.`;
      case "unmigrated":
        return `${who} is already saved under this name, as ${at}. If it's the same thing, update it with id "${at}". ${qualify}`;
    }
  }

  #insertHandle(h: string, s: string, at: string, origin: string) {
    this.db
      .prepare(
        "INSERT INTO handles(kind, handle, s, written_at, origin) VALUES ('handle', ?, ?, ?, ?)",
      )
      .run(h, s, at, origin);
  }

  /**
   * Give a record saved before handles the handle its current name makes (a forgotten one, its last name's). The
   * migration's verb: nothing else assigns a handle to an existing record. A record that already holds that handle is
   * left as it is, so a re-run is a no-op. Fails, naming the holder, when another record holds it.
   */
  mintHandle(id: string, origin: string = DIRECT): HandleResult {
    const r = this.resolve(id);
    if (r.status === "missing") return { ok: false, reason: `No record is addressed as "${id}".` };
    const s = `${E}${r.id}`;
    // A record forgotten before handles gets the handle its last name made, so that name stays reserved as forgotten.
    const label =
      this.#view(s).label ?? (r.status === "forgotten" ? this.#lastLabel(s) : undefined);
    if (label === undefined)
      return { ok: false, reason: `${r.id} has no name to make a handle from.` };
    const h = handleOf(label);
    if (!h)
      return { ok: false, reason: `"${label}" has no letters or digits to make a handle from.` };
    if (this.#liveHandles(s).includes(h)) return { ok: true, handle: h };
    // The migration settles namesakes among old records itself, so only a handle already held stops it.
    const holder = this.#holder(h, s, { unmigrated: false });
    if (holder) return { ok: false, reason: this.#takenMessage(label, h, holder), holder };
    this.#insertHandle(h, s, new Date().toISOString(), origin);
    dlog("mintHandle:", r.id, "→", h, `who=${whoOf(origin)}`);
    return { ok: true, handle: h };
  }

  /**
   * Free an earlier or forgotten handle, so the next record whose name makes it takes it, as a page move over a
   * redirect does. References to it then lead to that record. A record's current handle can't be reclaimed: rename
   * the record first.
   */
  reclaimHandle(handle: string, origin: string = DIRECT): HandleResult {
    const h = bare(handle);
    const holder = this.#holderOf(h);
    if (holder === undefined)
      return { ok: false, reason: `No record holds ${REFERENCE_PREFIX}${h}.` };
    if (this.#view(holder).exists && this.#handleFor(holder) === h)
      return {
        ok: false,
        reason: `${REFERENCE_PREFIX}${h} is the current handle of "${this.#view(holder).label ?? tail(holder)}". Rename that record before reclaiming it.`,
      };
    this.db.transaction(() => {
      const { lastInsertRowid } = this.db
        .prepare(
          "INSERT INTO handles(kind, handle, s, written_at, origin) VALUES ('reclaim', ?, ?, ?, ?)",
        )
        .run(h, holder, new Date().toISOString(), origin);
      this.db
        .prepare(
          "UPDATE handles SET superseded_by = ? WHERE kind = 'handle' AND handle = ? AND superseded_by IS NULL",
        )
        .run(lastInsertRowid, h);
    })();
    dlog("reclaimHandle:", h, "from", tail(holder), `who=${whoOf(origin)}`);
    return { ok: true, handle: h };
  }

  /**
   * Record that `duplicate` is the same thing as `into`, and retract the duplicate in the same write (its rows are
   * tombstoned with this origin, so `revertBatch` brings it back). References to its handles and id, and connections
   * to it, then lead to `into`; nothing is rewritten. Carry any details worth keeping over to `into` first.
   */
  merge(
    duplicate: string,
    into: string,
    origin: string = DIRECT,
  ): { ok: true } | { ok: false; reason: string } {
    // A record already merged that has been written to since under its own id (by a version that didn't follow
    // merges) is retracted again by that id: resolving it would land on `into`.
    const revived =
      this.#view(`${E}${duplicate}`).exists && this.#mergedInto(`${E}${duplicate}`) !== undefined;
    const from = revived
      ? ({ status: "found", id: duplicate, via: "id" } as const)
      : this.resolve(duplicate);
    const to = this.resolve(into);
    if (from.status === "missing")
      return { ok: false, reason: `No record is addressed as "${duplicate}".` };
    if (to.status !== "found")
      return { ok: false, reason: `No current record is addressed as "${into}".` };
    if (from.id === to.id)
      return { ok: false, reason: `"${duplicate}" and "${into}" are already the same record.` };
    const s = `${E}${from.id}`;
    const at = new Date().toISOString();
    // A merged page becomes a redirect: the duplicate stops being a record of its own, in the same write, so nothing
    // can reach it as one. Left live, it would still be recalled while every reference to it, a forget included,
    // landed on `into`.
    this.db.transaction(() => {
      for (const r of [...this.#current.all(s), ...this.#relations.all(s)]) {
        const edge = isRelation(r.p, r.ot);
        this.#ins(s, r.p, edge ? r.o : "", edge ? "tomb-edge" : "tomb", null, at, origin);
      }
      this.db
        .prepare(
          "INSERT INTO handles(kind, s, target, written_at, origin) VALUES ('merge', ?, ?, ?, ?)",
        )
        .run(s, `${E}${to.id}`, at, origin);
      this.#reindex(s);
    })();
    dlog("merge:", from.id, "→", to.id, `who=${whoOf(origin)}`);
    return { ok: true };
  }

  async #reparseShapes() {
    this.#shapes = await parseTurtle(this.#ontologyTtl);
    this.#dataValidator = new SHACLValidator(this.#shapes, { factory: rdf });
    this.#shapeIndex = indexShapes(this.#shapes);
    this.#rawClasses = new Set(
      [...(await parseTurtle(PREFIXES + this.#rawTtl))]
        .flatMap((q) => [q.subject.value, q.object.value])
        .filter((iri) => iri.startsWith(C))
        .map(localName),
    );
  }
  /** Every active authored rule — bounded by construction (personal scale: a handful). */
  shapeIndex(): ShapeEntry[] {
    return this.#shapeIndex;
  }
  // The current schema, folded from the log in order: each row is one change (a legacy store's starting definition,
  // or one extension's added details), so reverting any one entry removes exactly what it added.
  #loadSchema() {
    const rows = this.db.prepare("SELECT class, def, raw FROM schema_log ORDER BY seq").all() as {
      class: string | null;
      def: string | null;
      raw: string | null;
    }[];
    const defs: SchemaDefs = {};
    let raw = "";
    for (const r of rows) {
      if (r.class !== null && r.def !== null) {
        const change = JSON.parse(r.def) as { base?: TypeDef; add?: ExtendInput };
        defs[r.class] = change.base ?? mergeDef(defs[r.class], change.add ?? {});
      } else if (r.raw !== null) raw += r.raw;
    }
    this.#schemaDefs = defs;
    this.#rawTtl = raw;
    this.#ontologyTtl = renderOntology(defs, raw);
  }
  #logSchema(
    cls: string | null,
    def: { base: TypeDef } | { add: ExtendInput } | null,
    raw: string | null,
    origin: string,
  ) {
    this.db
      .prepare("INSERT INTO schema_log(class, def, raw, written_at, origin) VALUES (?, ?, ?, ?, ?)")
      .run(cls, def && JSON.stringify(def), raw, new Date().toISOString(), origin);
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
  async extendSchema(def: ExtendInput, origin: string = DIRECT): Promise<ExtendResult> {
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
      this.#logSchema(null, null, `\n${def.rawShape}\n`, origin);
      this.#loadSchema();
      await this.#reparseShapes();
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
    // The one control-plane rule: a type defined in the owner's own conversation is changed only there. It's keyed to
    // who recorded the definition, never to anything the model says, and a new type is open to any writer.
    if (whoOf(origin) !== "owner" && hasOwner(origin) && this.#ownerDefined(cls)) {
      dlog("extend_schema REFUSED: a non-owner write asked to change", cls);
      return {
        ok: false,
        stage: "owner-type",
        problems: [
          {
            message: `\`${cls}\` records were defined in the memory owner's own conversation, so only the memory owner's own conversation can change that definition. Define a new type instead, or ask the memory owner.`,
          },
        ],
      };
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
    this.#logSchema(
      cls,
      { add: { requires: def.requires, relations: def.relations } },
      null,
      origin,
    );
    this.#loadSchema();
    await this.#reparseShapes();
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

  // ---- remember: create a record (no id) or update one (id or handle), lint the result, append ----
  // Create and update are different verbs (Neo4j CREATE vs MERGE): a create whose handle is taken fails and names the
  // holder, so a thing is never saved twice by accident, and an update names the record it means. Updating sets
  // exactly the keys it supplies — the tool's input is one value per key, so a re-save means "this is now the value".
  // Nothing is overwritten: the prior value stays in the log, attributed.
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
    const fail = (stage: string, message: string, holder?: Holder): RememberResult => {
      dlog(`remember REJECTED (${stage}):`, message);
      return { ok: false, stage, problems: [{ message }], ...(holder ? { holder } : {}) };
    };
    const didYouMean = (r: { suggestions: string[] }) =>
      r.suggestions.length ? ` Did you mean ${r.suggestions.join(", ")}?` : "";
    // Every input that names a record goes through the one resolver, and the internal id is what's stored.
    const targets: string[] = [];
    for (const r of fact.relations ?? []) {
      const t = this.resolve(r.to);
      if (t.status === "missing")
        return fail(
          "target",
          `Can't connect ${r.relation} to "${r.to}": nothing is remembered by that handle.${didYouMean(t)} Connect to a remembered thing by its handle, or save it first.`,
        );
      if (t.status === "forgotten")
        return fail(
          "target",
          `Can't connect ${r.relation} to "${r.to}": ${REFERENCE_PREFIX}${t.handle ?? t.id} was forgotten${t.on ? ` on ${t.on}` : ""}.`,
        );
      targets.push(`${E}${t.id}`);
    }
    const creating = fact.id === undefined;
    let s: string;
    let mint: string | undefined;
    if (creating) {
      if (!fact.label)
        return fail("handle", "A new record needs a label: its handle is made from it.");
      mint = handleOf(fact.label);
      if (!mint)
        return fail(
          "handle",
          `"${String(fact.label).slice(0, 60)}" has no letters or digits to make a handle from. Give it a name that has some.`,
        );
      const taken = this.#taken(fact, mint, targets);
      if (taken) return taken;
      s = `${E}${this.#freshId(fact.label)}`;
    } else {
      const r = this.resolve(String(fact.id));
      if (r.status === "missing")
        return fail(
          "target",
          `Nothing is remembered as "${fact.id}".${didYouMean(r)} To save a new thing, leave id out.`,
        );
      // A forgotten record resolves to itself: saving it again brings it back under its own id and handle.
      s = `${E}${r.id}`;
      if (fact.label !== undefined) {
        const h = handleOf(fact.label);
        if (!h)
          return fail(
            "handle",
            `"${String(fact.label).slice(0, 60)}" has no letters or digits to make a handle from. Give it a name that has some.`,
          );
        const live = this.#liveHandles(s);
        if (!live.includes(h)) {
          const holder = this.#holder(h, s);
          if (holder)
            return fail("handle", this.#takenMessage(String(fact.label), h, holder), holder);
          // A record saved before handles keeps none until the migration gives it one: renaming it must not settle a
          // name the operator hasn't seen.
          if (live.length > 0) mint = h;
        }
      }
    }
    const id = tail(s);
    const before = this.#view(s);
    const ownerType = this.#ownerType(s);
    const target = fact.type ? pascal(fact.type) : before.exists ? undefined : "Thing";
    if (
      ownerType !== undefined &&
      target !== undefined &&
      target !== ownerType &&
      whoOf(origin) !== "owner" &&
      hasOwner(origin)
    ) {
      dlog("remember REFUSED: a non-owner write asked to re-type", id);
      return {
        ok: false,
        stage: "owner-type",
        problems: [
          {
            message: `${before.label ?? id} was typed \`${ownerType}\` in the memory owner's own conversation, so only the memory owner's own conversation can change its type. ${fact.type ? "Save the other details without a type, or ask the memory owner. If it's a different thing, save it as a new record with a name that tells them apart." : `The record was forgotten, and saving it again would type it \`Thing\`: save it with type \`${ownerType}\`, or ask the memory owner.`}`,
          },
        ],
      };
    }
    const want: Triple[] = [];
    if (fact.type || !before.exists)
      want.push({ s, p: TYPE, o: `${C}${pascal(fact.type ?? "Thing")}`, ot: "iri", dt: null });
    if (fact.label)
      want.push({ s, p: LABEL, o: String(fact.label), ot: "lit", dt: `${XSD}string` });
    for (const [k, v] of Object.entries(fact.attributes ?? {}))
      want.push({ s, p: `${P}${slug(k)}`, o: String(v), ot: "lit", dt: xsdOf(v) });
    const relations: Triple[] = (fact.relations ?? []).map((r, i) => ({
      s,
      p: `${P}${slug(r.relation)}`,
      o: targets[i] as string,
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
    this.#detectOwnerOverwrite(
      origin,
      id,
      changes.filter((w) => current.has(w.p)).map((w) => current.get(w.p) as Triple),
      this.#current.all(s),
    );
    if (changes.length + newRels.length > 0) {
      const at = new Date().toISOString();
      try {
        this.db.transaction(() => {
          for (const r of [...changes, ...newRels])
            this.#ins(r.s, r.p, r.o, r.ot, r.dt ?? null, at, origin);
          if (mint !== undefined) this.#insertHandle(mint, s, at, origin);
          this.#reindex(s);
        })();
      } catch (error) {
        // The unique index is the guarantee, not the check above: validation awaits, so a concurrent save of the same
        // name can pass that check too (Neo4j: only a constraint holds under concurrent writes). The losing write
        // rolled back whole; answer it as a replay, or as the taken handle it is.
        if (mint === undefined || (error as { code?: string }).code !== "SQLITE_CONSTRAINT_UNIQUE")
          throw error;
        const again = creating
          ? this.#taken(fact, mint, targets)
          : (() => {
              const holder = this.#holder(mint, s);
              return (
                holder &&
                fail("handle", this.#takenMessage(String(fact.label), mint, holder), holder)
              );
            })();
        if (again) return again;
        throw error;
      }
    }
    const view = this.#view(s);
    dlog(
      "remember COMMITTED to store:",
      id,
      `(${view.type})`,
      JSON.stringify(fact.attributes ?? {}),
      `who=${whoOf(origin)}`,
      superseded.length ? `superseded ${JSON.stringify(superseded)}` : "",
    );
    // Surface the handle on the turn it's made: it's how the agent refers to this record from now on.
    const handle = this.#handleFor(s, view.label);
    const ref = `${REFERENCE_PREFIX}${handle ?? id}`;
    let summary = `${before.exists ? "Updated" : "Remembered"} ${view.label ?? id} (${view.type ?? "untyped"}) as ${ref}. Use ${ref} to refer to it: to connect other things to it, in links, and to update it.`;
    if (superseded.length)
      summary += ` Replaced: ${superseded.map((c) => `${c.key} "${c.from}" → "${c.to}"`).join("; ")} (earlier values are kept in history).`;
    // Loud, never blocking: a rule binds by type, so a save under another type silently dodges it. Say so.
    const skipped = this.#shapeIndex.filter((r) => r.class !== view.type);
    if (skipped.length) {
      const shown = skipped.slice(0, 3).map((r) => r.summary);
      if (skipped.length > 3) shown.push(`+${skipped.length - 3} more`);
      summary += ` Saved as ${view.type ?? "untyped"}, so it was NOT checked against your other rules: ${shown.join("; ")}. If it is one of those kinds, save it with that type.`;
    }
    return { ok: true, id, handle, summary, superseded };
  }

  // A create on a handle someone holds: a replay of the holder's own content succeeds with it (eve re-runs a step
  // interrupted mid-write, so a save can arrive twice); anything else fails and names the holder.
  #taken(fact: RememberInput, h: string, targets: readonly string[]): RememberResult | undefined {
    const holder = this.#holder(h);
    if (holder === undefined) return undefined;
    const s = `${E}${holder.id}`;
    const v = this.#view(s);
    const replay =
      holder.holds !== "forgotten" &&
      v.label === String(fact.label) &&
      (!fact.type || v.type === pascal(fact.type)) &&
      Object.entries(fact.attributes ?? {}).every(
        ([k, val]) => v.attributes[slug(k)] === String(val),
      ) &&
      (fact.relations ?? []).every((r, i) =>
        v.relations.some((b) => b.p === `${P}${slug(r.relation)}` && b.o === targets[i]),
      );
    if (!replay) dlog("remember REJECTED (handle):", h, "held by", holder.id, `(${holder.holds})`);
    else dlog("remember REPLAYED:", h, "→", holder.id);
    if (!replay)
      return {
        ok: false,
        stage: "handle",
        problems: [{ message: this.#takenMessage(String(fact.label), h, holder) }],
        holder,
      };
    const ref = `${REFERENCE_PREFIX}${holder.handle ?? holder.id}`;
    return {
      ok: true,
      id: holder.id,
      handle: holder.handle,
      replayed: true,
      summary: `Already remembered: ${v.label} (${v.type ?? "untyped"}) as ${ref} holds all of this. Use ${ref} to refer to it.`,
      superseded: [],
    };
  }

  // ---- forget: retract a whole entity, or some of its details. Appends attributed tombstones — the current
  // view drops them, history keeps what was forgotten, and revertBatch can undo it. Re-remembering starts fresh.
  async forget(
    { id, details }: { id: string; details?: string[] },
    origin: string = DIRECT,
  ): Promise<ForgetResult> {
    const r = this.resolve(id);
    if (r.status === "missing")
      return {
        ok: false,
        reason: `Nothing is remembered as "${id}".${r.suggestions.length ? ` Did you mean ${r.suggestions.join(", ")}?` : ""}`,
      };
    if (r.status === "forgotten")
      return {
        ok: false,
        reason: `${REFERENCE_PREFIX}${r.handle ?? r.id} was already forgotten${r.on ? ` on ${r.on}` : ""}.`,
      };
    const s = `${E}${r.id}`;
    const before = this.#view(s);
    // An empty list is a mistake, not a request to forget everything: whole-entity forget is only when details is omitted.
    if (Array.isArray(details) && details.length === 0)
      return {
        ok: false,
        reason:
          "No details were named. To forget the whole thing, leave details out; to forget specific details, name them.",
      };
    const wanted = details ? new Set(details.map((d) => slug(d))) : null;
    const named = [...this.#current.all(s), ...this.#relations.all(s)].filter(
      (r) => !wanted || wanted.has(slug(keyOf(r.p))),
    );
    if (named.length === 0)
      return {
        ok: false,
        reason: `"${before.label ?? id}" has none of those details: ${(details ?? []).join(", ")}.`,
      };
    const rows = named.map(withoutOrigin);
    this.#detectOwnerOverwrite(origin, r.id, rows, named);
    const at = new Date().toISOString();
    this.db.transaction(() => {
      for (const r of rows)
        this.#ins(
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
    dlog("forget:", r.id, wanted ? forgotten.join(", ") : "(whole entity)", `who=${whoOf(origin)}`);
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
    return {
      ok: true,
      label: before.label ?? id,
      whole: !wanted,
      forgotten,
      breaks,
      lostCoverage,
    };
  }

  /** How many writes by a scheduled run, a delegated task or another principal replaced an owner-conversation value. */
  get ownerOverwrites(): number {
    return this.#ownerOverwrites;
  }

  // Detection, not a gate: a write by a scheduled run, a delegated task or another principal that replaces or retracts
  // a value written in the owner's own conversation lands, and is logged and counted so it can be found and reverted.
  #detectOwnerOverwrite(
    origin: string,
    id: string,
    replaced: readonly Triple[],
    currentRows: readonly StoredTriple[],
  ): void {
    const writer = whoOf(origin);
    if (writer !== "scheduled" && writer !== "delegated" && writer !== "other") return;
    const owners = new Set(
      currentRows.filter((r) => whoOf(r.origin) === "owner").map((r) => `${r.p} ${r.o}`),
    );
    const hit = replaced.filter((r) => owners.has(`${r.p} ${r.o}`)).map((r) => keyOf(r.p));
    if (hit.length === 0) return;
    this.#ownerOverwrites++;
    console.warn(
      `[mem] owner-overwrite #${this.#ownerOverwrites}: a ${writer} write changed ${id} (${hit.join(", ")}), values written in the owner's own conversation; origin ${origin}`,
    );
  }

  // The type the owner last gave a record, from the log: undefined if the owner never typed it, or last untyped it.
  #ownerType(s: string): string | undefined {
    const rows = this.db
      .prepare(`SELECT o, ot, origin FROM triples WHERE s = ? AND p = '${TYPE}' ORDER BY seq DESC`)
      .all(s) as { o: string; ot: string; origin: string | null }[];
    const last = rows.find((r) => ownerControlled(r.origin));
    return last?.ot === "iri" ? tail(last.o) : undefined;
  }

  // Whether the owner's saves depend on a type: any change to it was made in the owner's own conversation (creating it
  // or extending it), it was written before 0.3.0 and not as a scheduled or delegated write, or a raw shape names it.
  #ownerDefined(cls: string): boolean {
    if (this.#rawClasses.has(cls)) return true;
    const rows = this.db.prepare("SELECT origin FROM schema_log WHERE class = ?").all(cls) as {
      origin: string | null;
    }[];
    return rows.some((r) => ownerControlled(r.origin));
  }

  // A new record's id: its name plus a suffix no record holds yet. A clash would silently write into another record.
  #freshId(name: string): string {
    for (;;) {
      const id = `${slug(name)}_${Math.random().toString(36).slice(2, 6).padEnd(4, "0")}`;
      if (!this.#view(`${E}${id}`).exists) return id;
    }
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
        handle: this.#handleFor(s, v.label),
        label: v.label,
        type: v.type,
        attributes: v.attributes,
        recorded: v.recorded,
        recordedName: v.recordedName,
        recordedType: v.recordedType,
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
      handle: this.#handleFor(s, views.get(s)?.label),
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
    // A handle or id names the record outright; otherwise the words are searched.
    const named = this.resolve(about);
    let focus: string | undefined = named.status === "found" ? `${E}${named.id}` : undefined;
    if (focus === undefined) {
      const match = ftsQuery(about);
      if (match === null) {
        dlog("relate:", JSON.stringify(about), "→ (no searchable tokens)");
        return { found: false, connections: [] };
      }
      focus = (
        this.db.prepare("SELECT s FROM lit_fts WHERE o MATCH ? ORDER BY rank LIMIT 1").get(match) as
          | { s: string }
          | undefined
      )?.s;
    }
    if (focus === undefined) {
      dlog("relate:", JSON.stringify(about), "→ not found");
      return { found: false, connections: [] };
    }
    const v = this.#view(focus);
    // An edge to a merged record leads where the merge does; the edge itself is never rewritten.
    const connections = v.relations.slice(0, limit).map((r) => {
      const target = this.#followMerges(r.o);
      return {
        relation: tail(r.p),
        target: this.#view(target).label ?? this.#lastLabel(target) ?? tail(target),
        id: tail(target),
        handle: this.#handleFor(target),
      };
    });
    dlog(
      "relate:",
      JSON.stringify(about),
      "→",
      tail(focus),
      "has",
      connections.length,
      "connection(s)",
    );
    // Entity-scoped: return the focus entity's full attributes alongside its connections — the on-demand detail path.
    return {
      found: true,
      entity: tail(focus),
      handle: this.#handleFor(focus, v.label),
      label: v.label,
      type: v.type,
      attributes: v.attributes,
      recorded: v.recorded,
      recordedName: v.recordedName,
      recordedType: v.recordedType,
      connections,
    };
  }

  /** The current state of one entity (what reads serve), or null if nothing current is remembered under the id. */
  describe(id: string): Description | null {
    const r = this.resolve(id);
    if (r.status !== "found") return null;
    const v = this.#view(`${E}${r.id}`);
    return v.exists
      ? {
          id: r.id,
          handle: r.handle,
          label: v.label,
          type: v.type,
          attributes: v.attributes,
          relations: v.relations.map((r) => ({ relation: tail(r.p), to: tail(r.o) })),
          recorded: v.recorded,
          recordedName: v.recordedName,
          recordedType: v.recordedType,
        }
      : null;
  }

  // ---- operator surface: every write is attributed, so any value's history is inspectable and a batch revertible ----
  history(id: string): HistoryEntry[] {
    const r = this.resolve(id);
    if (r.status === "missing") return [];
    const s = `${E}${r.status === "found" && r.mergedFrom ? r.mergedFrom[0] : r.id}`;
    const parse = (o: string | null) => JSON.parse(o ?? "null");
    const facts = (
      this.db
        .prepare("SELECT p, o, written_at, origin FROM triples WHERE s=? ORDER BY seq")
        .all(s) as {
        p: string;
        o: string;
        written_at: string | null;
        origin: string | null;
      }[]
    ).map((t) => ({
      key: keyOf(t.p),
      value: t.p === TYPE ? tail(t.o) : t.o,
      writtenAt: t.written_at,
      origin: parse(t.origin),
    }));
    const names = (
      this.db
        .prepare(
          "SELECT kind, handle, target, written_at, origin FROM handles WHERE s = ? ORDER BY seq",
        )
        .all(s) as {
        kind: string;
        handle: string | null;
        target: string | null;
        written_at: string | null;
        origin: string | null;
      }[]
    ).map((h) => ({
      // Keys with a space: a detail's key never has one, so a detail named `handle` can't be mistaken for these.
      key:
        h.kind === "merge"
          ? "merged into"
          : h.kind === "reclaim"
            ? "handle reclaimed"
            : "record handle",
      value: h.kind === "merge" ? tail(h.target ?? "") : (h.handle ?? ""),
      writtenAt: h.written_at,
      origin: parse(h.origin),
    }));
    // Two logs, one timeline: a stable sort by write time keeps each log's own order.
    return [...facts, ...names].sort((x, y) =>
      (x.writtenAt ?? "").localeCompare(y.writtenAt ?? ""),
    );
  }
  /**
   * Drop every row one origin wrote (match on any of its fields, e.g. { callId } or { sessionId }); reads fall back.
   * Handles, reclaims and merges are rows like any other. A revert that would leave a record answering to a handle
   * another record has taken since (undoing a rename or a reclaim after the name moved on) is not applied: nothing is
   * removed, and `conflicts` names each one so it can be settled first.
   */
  async revertBatch(match: Record<string, string | number>): Promise<{
    removed: number;
    schema: number;
    entities: string[];
    untyped: string[];
    conflicts: { id: string; handle: string; heldBy: string }[];
  }> {
    const keys = Object.keys(match);
    if (keys.length === 0) throw new Error("revertBatch needs at least one origin field to match");
    const where = keys
      .map((k) => `json_extract(origin, '$.${k.replace(/[^a-zA-Z]/g, "")}') = ?`)
      .join(" AND ");
    const args = keys.map((k) => match[k]);
    const conflicts: { id: string; handle: string; heldBy: string }[] = [];
    const refused = new Error("revert conflicts");
    let result:
      | { removed: number; schema: number; entities: string[]; untyped: string[] }
      | undefined;
    try {
      result = this.db.transaction(() => {
        const schema = this.db
          .prepare(`DELETE FROM schema_log WHERE ${where}`)
          .run(...args).changes;
        const affected = new Set(
          (
            this.db.prepare(`SELECT DISTINCT s FROM triples WHERE ${where}`).all(...args) as {
              s: string;
            }[]
          ).map((r) => r.s),
        );
        const names = this.db
          .prepare(`SELECT seq, kind, handle, s FROM handles WHERE ${where}`)
          .all(...args) as { seq: number; kind: string; handle: string | null; s: string }[];
        for (const n of names) affected.add(n.s);
        const removed =
          this.db.prepare(`DELETE FROM triples WHERE ${where}`).run(...args).changes +
          this.db.prepare(`DELETE FROM handles WHERE ${where}`).run(...args).changes;
        // Undoing a reclaim makes the handle its earlier holder's again, unless another record has taken it since (one
        // this batch made is already gone).
        for (const n of names.filter((x) => x.kind === "reclaim")) {
          const taker = n.handle === null ? undefined : this.#holderOf(n.handle);
          if (taker !== undefined && n.handle !== null) {
            conflicts.push({ id: tail(n.s), handle: n.handle, heldBy: tail(taker) });
            continue;
          }
          this.db
            .prepare("UPDATE handles SET superseded_by = NULL WHERE superseded_by = ?")
            .run(n.seq);
        }
        for (const s of affected) {
          this.#reindex(s);
          // A record whose name comes back must not come back to a handle someone else holds now.
          const label = this.#view(s).label;
          const h = label === undefined ? "" : handleOf(label);
          const holder = h ? this.#holderOf(h) : undefined;
          const hadHandle = this.db
            .prepare("SELECT 1 FROM handles WHERE kind = 'handle' AND s = ?")
            .get(s);
          if (holder !== undefined && holder !== s && hadHandle !== undefined)
            conflicts.push({ id: tail(s), handle: h, heldBy: tail(holder) });
        }
        if (conflicts.length) throw refused;
        // A batch that wrote only an entity's type leaves its other details behind with no type: still readable, but
        // outside every rule. Report them so the operator can re-type or revert further.
        const untyped = [...affected]
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
          affected.size,
          "entit(ies)",
          untyped.length ? `untyped: ${untyped.join(", ")}` : "",
        );
        return { removed, schema, entities: [...affected].map(tail), untyped };
      })();
    } catch (error) {
      if (error !== refused) throw error;
      dlog("revertBatch REFUSED:", JSON.stringify(match), JSON.stringify(conflicts));
      return { removed: 0, schema: 0, entities: [], untyped: [], conflicts };
    }
    if (result.schema > 0) {
      this.#loadSchema();
      await this.#reparseShapes();
    }
    return { ...result, conflicts };
  }
}
