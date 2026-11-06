// Give the records of a store saved before handles their handles. A dry run plans every scope on a copy of its store
// and reports each clash (records whose names make one handle) with the choices that would settle it, each tried on
// the copy. Apply carries out the operator's decisions on the store itself, through the graph's own verbs, under one
// run's origin, so `revertBatch({ run })` undoes it. Nothing is assigned a handle unless its clash was decided.

import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  handleOf,
  LIVE_EDGES_SQL,
  LIVE_HANDLES_SQL,
  LIVE_RECORDS_SQL,
  MemoryGraph,
  REFERENCE_PREFIX,
  slug,
  TRIPLES_SQL,
} from "./memory-graph.js";
import { openReadOnly } from "./stats.js";

type Stored = NonNullable<ReturnType<MemoryGraph["stored"]>>;

export type MemberState = "live" | "forgotten" | "revived" | "id";

export interface Member {
  id: string;
  /** live: a current record; forgotten: forgotten, its name unreserved; revived: merged, then written to again under
   * its own id; id: a record whose internal id is the handle (it keeps its id, so it holds the name). */
  state: MemberState;
  label?: string;
  type?: string;
  /** Whether the record already holds this clash's handle. */
  holds: boolean;
  keys: string[];
  values: Record<string, string>;
  edges: { relation: string; to: string }[];
  firstWritten: string | null;
  lastWritten: string | null;
  writers: string[];
}

export type Choice =
  | "survivor"
  | { merge: string }
  | { qualify: string }
  | "release"
  | "reserve"
  | "skip-mint"
  | "carry";

export interface Decision {
  clash: string;
  digest: string;
  skip?: true;
  members?: Record<string, Choice>;
  /** For a merge: a detail both records hold, taken from the duplicate named. Unnamed, the survivor's stays. */
  keys?: Record<string, string>;
}

export interface Option {
  letter: string;
  summary: string;
  decision: Decision;
  ok: boolean;
  problems: string[];
}

export type ClashKind = "name" | "revived" | "mint";

export interface Clash {
  key: string;
  ref: string;
  kind: ClashKind;
  handle: string;
  members: Member[];
  proposal: "duplicate" | "namesake" | "unclear";
  evidence: string[];
  digest: string;
  options: Option[];
  /** The member a custom qualifier (`Q:"<label>"`) renames. */
  qualifyTarget?: string;
}

export interface RefCheck {
  ref: string;
  /** Where 0.5.2 resolved it (its id, slugged), if anywhere. */
  legacy: string | null;
  before: string | null;
  after: string | null;
  outcome: "ok" | "pin-break" | "migration-break";
}

export interface Counts {
  records: number;
  edges: number;
  triples: number;
  handles: number;
}

export interface ScopeReport {
  scope: string;
  clashes: Clash[];
  /** Records that get a handle with no clash. */
  mints: string[];
  /** Records with no name to make a handle from. */
  unnamed: string[];
  refs: RefCheck[];
  before: Counts;
  after?: Counts;
  applied?: ApplyResult;
}

export interface ApplyResult {
  run: string;
  applied: string[];
  skipped: { clash: string; reason: string }[];
  failed: { clash: string; reason: string }[];
  merges: number;
  minted: number;
  rowsWritten: number;
  rowsReverted: number;
}

export interface Report {
  mode: "dry-run" | "apply";
  dir: string;
  version: string;
  scopes: ScopeReport[];
}

const STORE = "graph.db";
const at = (r: { status: string; id?: string }) => (r.status === "missing" ? null : (r.id ?? null));
const sorted = <T>(xs: T[], key: (x: T) => string) =>
  [...xs].sort((a, b) => key(a).localeCompare(key(b)));
const typed = (v: string, dt: string | undefined): string | number | boolean =>
  dt === "integer" || dt === "decimal" ? Number(v) : dt === "boolean" ? v === "true" : v;

const counts = (g: MemoryGraph): Counts => {
  const n = (sql: string) => (g.db.prepare(sql).get() as { n: number }).n;
  return {
    records: n(LIVE_RECORDS_SQL),
    edges: n(LIVE_EDGES_SQL),
    triples: n(TRIPLES_SQL),
    handles: n(LIVE_HANDLES_SQL),
  };
};

function member(st: Stored, state: MemberState, handle: string): Member {
  return {
    id: st.id,
    state,
    label: st.label ?? st.lastLabel,
    type: st.type,
    holds: st.handles.includes(handle),
    keys: Object.keys(st.attributes).sort(),
    values: st.attributes,
    edges: sorted(st.relations, (r) => `${r.relation}\u0000${r.to}`),
    firstWritten: st.firstWritten,
    lastWritten: st.lastWritten,
    writers: st.writers,
  };
}

// What a decision depends on: who the members are, what they're called and typed, and which details and connections
// are in play among them. A write that changes a value but adds no key leaves a decision standing; carrying a detail
// from one member to another leaves the union as it was, so a re-run after a partial apply still matches.
function digestOf(kind: ClashKind, members: Member[]): string {
  const keys = [...new Set(members.flatMap((m) => m.keys))].sort();
  const edges = [
    ...new Set(members.flatMap((m) => m.edges.map((e) => `${e.relation}→${e.to}`))),
  ].sort();
  const who = sorted(members, (m) => m.id).map((m) => [m.id, m.state, m.label, m.type]);
  return createHash("sha256")
    .update(JSON.stringify({ kind, who, keys, edges }))
    .digest("hex")
    .slice(0, 16);
}

// Evidence for one real thing saved twice, or two things sharing a name. It proposes; the operator decides.
function classify(
  members: Member[],
  hubs: Set<string>,
): { proposal: Clash["proposal"]; evidence: string[] } {
  const live = members.filter((m) => m.state === "live");
  if (live.length < 2 || members.some((m) => m.state !== "live"))
    return { proposal: "unclear", evidence: [] };
  const same: string[] = [];
  const apart: string[] = [];
  for (let i = 0; i < live.length; i++)
    for (let j = i + 1; j < live.length; j++) {
      const [a, b] = [live[i], live[j]];
      if ((a.type === "Thing") !== (b.type === "Thing"))
        same.push(`${a.id}/${b.id}: one is untyped (Thing)`);
      else if (a.type !== b.type) apart.push(`${a.id}/${b.id}: types ${a.type} and ${b.type}`);
      for (const k of a.keys)
        if (b.keys.includes(k) && a.values[k] === b.values[k])
          same.push(`${a.id}/${b.id}: same ${k}`);
      for (const e of a.edges)
        if (!hubs.has(e.to) && b.edges.some((f) => f.relation === e.relation && f.to === e.to))
          same.push(`${a.id}/${b.id}: both ${e.relation} → ${e.to}`);
      // A relation each holds once, to different targets, is evidence of two things; one held many times isn't.
      for (const rel of new Set(a.edges.map((e) => e.relation))) {
        const ta = a.edges.filter((e) => e.relation === rel);
        const tb = b.edges.filter((e) => e.relation === rel);
        if (ta.length === 1 && tb.length === 1 && ta[0].to !== tb[0].to)
          apart.push(`${a.id}/${b.id}: ${rel} → ${ta[0].to} and ${tb[0].to}`);
      }
    }
  const proposal =
    same.length && !apart.length
      ? "duplicate"
      : apart.length && !same.length
        ? "namesake"
        : "unclear";
  return { proposal, evidence: [...same, ...apart] };
}

const qualified = (m: Member, others: Member[]) =>
  m.type && m.type !== "Thing" && !others.some((o) => o.type === m.type)
    ? `${m.label} (${m.type})`
    : `${m.label} (2)`;

// The choices put to the operator for a name clash. Only one member may end up answering to the bare handle; a member
// that already holds it must be the one that keeps it.
function nameOptions(c: Pick<Clash, "key" | "digest" | "members">): {
  options: Omit<Option, "letter" | "ok" | "problems">[];
  qualifyTarget?: string;
} {
  const byAge = sorted(c.members, (m) => m.firstWritten ?? "");
  const live = byAge.filter((m) => m.state === "live");
  const forgotten = byAge.filter((m) => m.state === "forgotten");
  const idHolder = c.members.find((m) => m.state === "id");
  const holder = live.find((m) => m.holds);
  const release = Object.fromEntries(forgotten.map((m) => [m.id, "release" as Choice]));
  const base = { clash: c.key, digest: c.digest };
  const out: Omit<Option, "letter" | "ok" | "problems">[] = [];
  const newest = [...live].reverse().find((m) => !m.holds && m.state === "live");
  if (idHolder) {
    const minting = live.filter((m) => !m.holds);
    out.push({
      summary: `qualify ${minting.map((m) => m.id).join(", ")}; ${idHolder.id} keeps the name as its id`,
      decision: {
        ...base,
        members: Object.fromEntries([
          ...minting.map((m) => [m.id, { qualify: qualified(m, c.members) }]),
          ...forgotten.map((m) => [m.id, "release"]),
        ]),
      },
    });
    out.push({
      summary: `leave ${minting.map((m) => m.id).join(", ")} without a handle (each resolves by its id)`,
      decision: {
        ...base,
        members: Object.fromEntries([
          ...minting.map((m) => [m.id, "skip-mint"]),
          ...forgotten.map((m) => [m.id, "release"]),
        ]),
      },
    });
    return { options: out, qualifyTarget: minting[0]?.id };
  }
  if (live.length >= 2) {
    for (const survivor of holder ? [holder] : [live[0], live.at(-1) as Member]) {
      out.push({
        summary: `merge ${live
          .filter((m) => m !== survivor)
          .map((m) => m.id)
          .join(
            ", ",
          )} into ${survivor.id}${forgotten.length ? "; release the forgotten name" : ""}`,
        decision: {
          ...base,
          members: {
            ...release,
            ...Object.fromEntries(
              live.map((m) => [m.id, m === survivor ? "survivor" : { merge: survivor.id }]),
            ),
          },
        },
      });
    }
    const keeper = holder ?? live[0];
    out.push({
      summary: `keep ${keeper.id} as the name; qualify ${live
        .filter((m) => m !== keeper)
        .map((m) => m.id)
        .join(", ")}`,
      decision: {
        ...base,
        members: {
          ...release,
          ...Object.fromEntries(
            live.map((m) => [
              m.id,
              m === keeper
                ? "survivor"
                : {
                    qualify: qualified(
                      m,
                      live.filter((o) => o !== m),
                    ),
                  },
            ]),
          ),
        },
      },
    });
    return { options: out, qualifyTarget: newest?.id };
  }
  if (live.length === 1) {
    const [m] = live;
    out.push({
      summary: `${m.id} takes the name; release the forgotten name`,
      decision: { ...base, members: { ...release, [m.id]: "survivor" } },
    });
    if (!m.holds)
      out.push({
        summary: `the forgotten record keeps its name; qualify ${m.id}`,
        decision: {
          ...base,
          members: {
            [m.id]: { qualify: qualified(m, c.members) },
            ...Object.fromEntries(forgotten.map((f, i) => [f.id, i === 0 ? "reserve" : "release"])),
          },
        },
      });
    return { options: out, qualifyTarget: m.holds ? undefined : m.id };
  }
  out.push({
    summary: `reserve the name for ${forgotten[0].id}; release the others`,
    decision: {
      ...base,
      members: Object.fromEntries(forgotten.map((f, i) => [f.id, i === 0 ? "reserve" : "release"])),
    },
  });
  out.push({ summary: "release every forgotten name", decision: { ...base, members: release } });
  return { options: out };
}

const withSkip = (
  c: Pick<Clash, "key" | "digest">,
  options: Omit<Option, "letter" | "ok" | "problems">[],
): Option[] =>
  [
    ...options,
    { summary: "skip", decision: { clash: c.key, digest: c.digest, skip: true as const } },
  ].map((o, i) => ({ ...o, letter: String.fromCharCode(65 + i), ok: true, problems: [] }));

/** The structural rules every decision obeys, before anything is tried. */
export function decisionProblems(g: MemoryGraph, c: Clash, d: Decision): string[] {
  if (d.skip) return [];
  const problems: string[] = [];
  const choices = d.members ?? {};
  for (const m of c.members) {
    const ch = choices[m.id];
    if (m.state === "id") {
      if (ch !== undefined) problems.push(`${m.id} keeps its id; it takes no choice`);
      continue;
    }
    if (ch === undefined) {
      problems.push(`no choice for ${m.id}`);
      continue;
    }
    const allowed =
      m.state === "forgotten"
        ? ch === "release" || ch === "reserve"
        : m.state === "revived"
          ? ch === "carry"
          : ch === "survivor" || ch === "skip-mint" || typeof ch === "object";
    if (!allowed) problems.push(`${m.id} (${m.state}) can't take ${JSON.stringify(ch)}`);
    if (m.holds && ch !== "survivor" && m.state === "live")
      problems.push(
        `${m.id} already holds ${REFERENCE_PREFIX}${c.handle}, so it must be the one that keeps it`,
      );
  }
  for (const id of Object.keys(choices))
    if (!c.members.some((m) => m.id === id)) problems.push(`${id} isn't in this clash`);
  const survivors = c.members.filter((m) => choices[m.id] === "survivor");
  for (const m of c.members) {
    const ch = choices[m.id];
    if (typeof ch === "object" && "merge" in ch) {
      if (!survivors.some((s) => s.id === ch.merge))
        problems.push(`${m.id} merges into ${ch.merge}, which isn't this clash's survivor`);
    }
    if (typeof ch === "object" && "qualify" in ch) {
      const h = handleOf(ch.qualify);
      if (!h) problems.push(`"${ch.qualify}" has no letters or digits to make a handle from`);
      else if (h === c.handle) problems.push(`"${ch.qualify}" makes the same handle`);
      else if (g.resolve(h).status !== "missing")
        problems.push(`"${ch.qualify}" makes ${REFERENCE_PREFIX}${h}, which is taken`);
    }
  }
  const bare =
    survivors.length +
    c.members.filter((m) => choices[m.id] === "reserve").length +
    c.members.filter((m) => m.state === "id").length;
  if (c.kind === "name" && bare > 1)
    problems.push(`${bare} records would answer to ${REFERENCE_PREFIX}${c.handle}; only one can`);
  const quals = c.members
    .map((m) => choices[m.id])
    .flatMap((ch) => (typeof ch === "object" && "qualify" in ch ? [handleOf(ch.qualify)] : []));
  if (new Set(quals).size !== quals.length) problems.push("two qualifiers make the same handle");
  for (const [key, from] of Object.entries(d.keys ?? {})) {
    const m = c.members.find((x) => x.id === from);
    const ch = choices[from];
    if (!m || !(typeof ch === "object" && "merge" in ch))
      problems.push(`${key} is taken from ${from}, which isn't merged`);
    else if (!m.keys.includes(key)) problems.push(`${from} has no ${key}`);
  }
  return problems;
}

interface Planned {
  scope: string;
  clashes: Clash[];
  mints: string[];
  unnamed: string[];
}

/** Every record's would-be handle, grouped: one claimant mints; two or more are a clash for the operator. */
export function plan(g: MemoryGraph, scope: string): Planned {
  const want = new Map<string, Stored[]>();
  const revived: { st: Stored; into: string }[] = [];
  const unnamed: string[] = [];
  for (const id of g.storedIds()) {
    const st = g.stored(id);
    if (!st) continue;
    if (st.merged) {
      // A merge retracts the duplicate; one with a current view again was written to since, by its own id.
      if (st.exists) {
        const r = g.resolve(id);
        if (r.status === "found" && r.id !== id) revived.push({ st, into: r.id });
      }
      continue;
    }
    if (!st.exists && st.handles.length) continue;
    const label = st.exists ? st.label : st.lastLabel;
    const h = label === undefined ? "" : handleOf(label);
    if (!h) {
      if (st.exists) unnamed.push(id);
      continue;
    }
    if (st.exists && st.handles.includes(h)) continue;
    want.set(h, [...(want.get(h) ?? []), st]);
  }
  // A connection target linked from a quarter of the scope's records says little about identity.
  const inbound = new Map<string, number>();
  let live = 0;
  for (const id of g.storedIds()) {
    const st = g.stored(id);
    if (!st?.exists) continue;
    live++;
    for (const r of st.relations) inbound.set(r.to, (inbound.get(r.to) ?? 0) + 1);
  }
  const hubs = new Set([...inbound].filter(([, n]) => n >= 3 && n > live / 4).map(([to]) => to));

  const clashes: Clash[] = [];
  const mints: string[] = [];
  for (const [h, claimants] of sorted([...want], ([h]) => h)) {
    const members = claimants.map((st) => member(st, st.exists ? "live" : "forgotten", h));
    const r = g.resolve(h);
    const holderId = at(r);
    if (holderId && !members.some((m) => m.id === holderId)) {
      const st = g.stored(holderId);
      if (st) {
        const state: MemberState =
          r.status === "found" && r.via === "id" ? "id" : st.exists ? "live" : "forgotten";
        members.push({ ...member(st, state, h), holds: state !== "id" });
      }
    }
    if (members.length === 1) {
      mints.push(members[0].id);
      continue;
    }
    const key = `${scope}/${h}`;
    const digest = digestOf("name", members);
    const { proposal, evidence } = classify(members, hubs);
    const { options, qualifyTarget } = nameOptions({ key, digest, members });
    clashes.push({
      key,
      ref: "",
      kind: "name",
      handle: h,
      members,
      proposal,
      evidence,
      digest,
      options: withSkip({ key, digest }, options),
      qualifyTarget,
    });
  }
  for (const { st, into } of revived) {
    const target = g.stored(into);
    if (!target) continue;
    const h = target.handles.at(-1) ?? handleOf(target.label ?? into);
    const members = [member(st, "revived", h), member(target, "live", h)];
    const key = `${scope}/revived:${st.id}`;
    const digest = digestOf("revived", members);
    clashes.push({
      key,
      ref: "",
      kind: "revived",
      handle: h,
      members,
      proposal: "duplicate",
      evidence: [`${st.id} was merged into ${into}, then written to under its own id`],
      digest,
      options: withSkip({ key, digest }, [
        {
          summary: `carry what was written to ${st.id} since its merge over to ${into}, then retract it again`,
          decision: { clash: key, digest, members: { [st.id]: "carry", [into]: "survivor" } },
        },
      ]),
    });
  }
  return { scope, clashes, mints, unnamed };
}

const originOf = (run: string, extra: Record<string, string>) =>
  JSON.stringify({ source: "migration", who: "unattributed", run, ...extra });

// Carry a duplicate's details over to the survivor: those only it holds, and those the decision takes from it. Type
// and name stay the survivor's. A connection is carried only to something that still resolves.
async function carry(
  g: MemoryGraph,
  survivor: string,
  dup: string,
  take: string[],
  everything: boolean,
  origin: string,
): Promise<string | undefined> {
  const s = g.stored(survivor);
  const d = g.stored(dup);
  if (!s || !d) return `${survivor} or ${dup} is gone`;
  const attributes: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(d.attributes))
    if (everything || !(k in s.attributes) || take.includes(k))
      if (s.attributes[k] !== v) attributes[k] = typed(v, d.datatypes[k]);
  const relations = d.relations.filter(
    (r) =>
      !s.relations.some((x) => x.relation === r.relation && x.to === r.to) &&
      r.to !== dup &&
      r.to !== survivor &&
      g.resolve(r.to).status === "found",
  );
  if (!Object.keys(attributes).length && !relations.length) return undefined;
  const r = await g.remember({ id: survivor, attributes, relations }, origin);
  return r.ok ? undefined : r.problems.map((p) => p.constraint ?? p.path ?? "a rule").join("; ");
}

/**
 * Carry out decisions, phase by phase across every clash (carry-overs, merges, qualifying names, then handles), so
 * no carried connection resolves through a merge made in the same run. A clash whose step fails is reverted alone and
 * the run goes on; a clash with no decision, or whose digest no longer matches, is skipped and reported.
 */
export async function apply(
  g: MemoryGraph,
  p: Planned,
  decisions: Decision[],
  run: string,
): Promise<ApplyResult> {
  const result: ApplyResult = {
    run,
    applied: [],
    skipped: [],
    failed: [],
    merges: 0,
    minted: 0,
    rowsWritten: 0,
    rowsReverted: 0,
  };
  const live = new Map<string, { c: Clash; d: Decision }>();
  for (const c of p.clashes) {
    const d = decisions.find((x) => x.clash === c.key);
    if (!d) result.skipped.push({ clash: c.key, reason: "no decision" });
    else if (d.digest !== c.digest)
      result.skipped.push({ clash: c.key, reason: "changed since it was decided" });
    else if (d.skip) result.skipped.push({ clash: c.key, reason: "decided: skip" });
    else {
      const problems = decisionProblems(g, c, d);
      if (problems.length) result.skipped.push({ clash: c.key, reason: problems.join("; ") });
      else live.set(c.key, { c, d });
    }
  }
  const fail = async (key: string, reason: string) => {
    if (!live.has(key)) return;
    live.delete(key);
    const r = await g.revertBatch({ run, clash: key });
    result.rowsReverted += r.removed;
    result.failed.push({
      clash: key,
      reason: r.conflicts.length
        ? `${reason}; revert conflicts: ${JSON.stringify(r.conflicts)}`
        : reason,
    });
  };
  const each = async (
    step: (c: Clash, d: Decision, origin: string) => Promise<string | undefined>,
  ) => {
    for (const [key, { c, d }] of [...live]) {
      const problem = await step(c, d, originOf(run, { clash: key }));
      if (problem) await fail(key, problem);
    }
  };
  const merges = (c: Clash, d: Decision) =>
    c.members.flatMap((m) => {
      const ch = d.members?.[m.id];
      return typeof ch === "object" && "merge" in ch
        ? [{ dup: m.id, into: ch.merge }]
        : ch === "carry"
          ? [{ dup: m.id, into: c.members.find((x) => d.members?.[x.id] === "survivor")?.id ?? "" }]
          : [];
    });
  await each(async (c, d, origin) => {
    for (const { dup, into } of merges(c, d)) {
      const take = Object.entries(d.keys ?? {}).flatMap(([k, from]) => (from === dup ? [k] : []));
      const problem = await carry(g, into, dup, take, d.members?.[dup] === "carry", origin);
      if (problem) return `carrying ${dup} into ${into}: ${problem}`;
    }
    return undefined;
  });
  await each(async (c, d, origin) => {
    for (const { dup, into } of merges(c, d)) {
      const r = g.merge(dup, into, origin);
      if (!r.ok) return `merging ${dup} into ${into}: ${r.reason}`;
    }
    return undefined;
  });
  await each(async (c, d, origin) => {
    for (const m of c.members) {
      const ch = d.members?.[m.id];
      if (typeof ch === "object" && "qualify" in ch) {
        const r = await g.remember({ id: m.id, label: ch.qualify }, origin);
        if (!r.ok)
          return `renaming ${m.id}: ${r.problems.map((x) => x.constraint ?? "a rule").join("; ")}`;
      }
    }
    return undefined;
  });
  await each(async (c, d, origin) => {
    for (const m of c.members) {
      const ch = d.members?.[m.id];
      if (ch === "survivor" || ch === "reserve" || (typeof ch === "object" && "qualify" in ch)) {
        const r = g.mintHandle(m.id, origin);
        if (!r.ok) return `giving ${m.id} its handle: ${r.reason}`;
      }
    }
    return undefined;
  });
  for (const [key] of live) result.applied.push(key);
  for (const id of p.mints) g.mintHandle(id, originOf(run, { record: id }));
  const n = (sql: string) => (g.db.prepare(sql).get(run) as { n: number }).n;
  result.merges = n(
    "SELECT count(*) AS n FROM handles WHERE kind = 'merge' AND json_extract(origin, '$.run') = ?",
  );
  result.minted = n(
    "SELECT count(*) AS n FROM handles WHERE kind = 'handle' AND json_extract(origin, '$.run') = ?",
  );
  result.rowsWritten = n(
    "SELECT count(*) AS n FROM triples WHERE json_extract(origin, '$.run') = ?",
  );
  return result;
}

const REF = /knowledge:([^\s<>|]+)/g;

/** References found in the scope's own details, as `knowledge:<x>` values. */
export function attributeRefs(g: MemoryGraph): string[] {
  const out = new Set<string>();
  for (const id of g.storedIds())
    for (const v of Object.values(g.stored(id)?.attributes ?? {}))
      for (const m of v.matchAll(REF)) out.add(m[1]);
  return [...out].sort();
}

// Where 0.5.2 sent a reference: the slugged id, if a record is there.
const legacyTarget = (g: MemoryGraph, x: string) => (g.stored(slug(x))?.exists ? slug(x) : null);

export function resolveAll(g: MemoryGraph, refs: string[]): Map<string, string | null> {
  return new Map(refs.map((x) => [x, at(g.resolve(x))]));
}

/** Each reference before and after: one that resolved and now leads elsewhere than its old target's redirect broke. */
export function checkRefs(
  g: MemoryGraph,
  refs: string[],
  legacy: Map<string, string | null>,
  before: Map<string, string | null>,
): RefCheck[] {
  return refs.map((ref) => {
    const b = before.get(ref) ?? null;
    const a = at(g.resolve(ref));
    const l = legacy.get(ref) ?? null;
    // Where the old target leads now: itself, or its survivor if it was merged. Not a handle lookup of its id,
    // which a new handle equal to that id would capture.
    const redirect = b === null ? null : g.stored(b)?.merged ? at(g.resolve(b)) : b;
    const outcome: RefCheck["outcome"] =
      b !== null && a !== redirect
        ? "migration-break"
        : l !== null && b === null
          ? "pin-break"
          : "ok";
    return { ref, legacy: l, before: b, after: a, outcome };
  });
}

/** A copy of a scope's store to plan on: the live one is opened read-only and never written. */
export async function snapshot(
  storeDir: string,
): Promise<{ graph: MemoryGraph; done: () => void }> {
  const tmp = mkdtempSync(join(tmpdir(), "eve-memory-migrate-"));
  const src = openReadOnly(join(storeDir, STORE));
  try {
    await src.backup(join(tmp, STORE));
  } finally {
    src.close();
  }
  const graph = await MemoryGraph.create({ dir: tmp });
  return {
    graph,
    done: () => {
      graph.close();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/**
 * Plan one scope on a copy, try each option of each clash there (each undone before the next), and check what the
 * clash-free handles alone would do to references, so a handle that would capture a reference is a clash too.
 */
export async function dryRun(
  storeDir: string,
  scope: string,
  extraRefs: string[],
): Promise<ScopeReport> {
  const { graph: g, done } = await snapshot(storeDir);
  try {
    const before = counts(g);
    const p = plan(g, scope);
    for (const c of p.clashes)
      for (const o of c.options) {
        o.problems = decisionProblems(g, c, o.decision);
        if (!o.problems.length && !o.decision.skip) {
          g.db.exec("SAVEPOINT probe");
          try {
            const r = await apply(g, { ...p, clashes: [c], mints: [] }, [o.decision], "probe");
            o.problems = [...r.failed, ...r.skipped].map((x) => x.reason);
          } finally {
            g.db.exec("ROLLBACK TO probe; RELEASE probe");
          }
        }
        o.ok = o.problems.length === 0;
      }
    const refs = [...new Set([...extraRefs, ...attributeRefs(g)])];
    const legacy = new Map(refs.map((x) => [x, legacyTarget(g, x)]));
    const pre = resolveAll(g, refs);
    g.db.exec("SAVEPOINT mints");
    let checks: RefCheck[];
    try {
      for (const id of p.mints) g.mintHandle(id, originOf("probe", { record: id }));
      checks = checkRefs(g, refs, legacy, pre);
    } finally {
      g.db.exec("ROLLBACK TO mints; RELEASE mints");
    }
    // A clash-free handle that would capture a reference becomes a decision of its own.
    for (const ch of checks.filter((x) => x.outcome === "migration-break" && x.after)) {
      const id = ch.after as string;
      if (!p.mints.includes(id)) continue;
      p.mints = p.mints.filter((m) => m !== id);
      const st = g.stored(id);
      if (!st) continue;
      const h = handleOf(st.label ?? "");
      const members = [member(st, "live", h)];
      const key = `${scope}/mint:${id}`;
      const digest = digestOf("mint", members);
      p.clashes.push({
        key,
        ref: "",
        kind: "mint",
        handle: h,
        members,
        proposal: "unclear",
        evidence: [
          `${REFERENCE_PREFIX}${ch.ref} resolves to ${ch.before}; this handle would take it`,
        ],
        digest,
        options: withSkip({ key, digest }, [
          {
            summary: `leave ${id} without a handle (it resolves by its id)`,
            decision: { clash: key, digest, members: { [id]: "skip-mint" } },
          },
          {
            summary: `qualify ${id}`,
            decision: {
              clash: key,
              digest,
              members: { [id]: { qualify: qualified(members[0], []) } },
            },
          },
        ]),
        qualifyTarget: id,
      });
    }
    return { ...p, refs: checkRefs(g, refs, legacy, pre), before };
  } finally {
    done();
  }
}

/** Apply decisions to one scope's store itself. The agent that owns the store must be stopped. */
export async function applyScope(
  storeDir: string,
  scope: string,
  decisions: Decision[],
  extraRefs: string[],
  run: string,
): Promise<ScopeReport> {
  const g = await MemoryGraph.create({ dir: storeDir });
  try {
    const before = counts(g);
    const p = plan(g, scope);
    const refs = [...new Set([...extraRefs, ...attributeRefs(g)])];
    const legacy = new Map(refs.map((x) => [x, legacyTarget(g, x)]));
    const pre = resolveAll(g, refs);
    // A clash-free handle the dry run found capturing a reference is minted only as decided.
    for (const d of decisions) {
      const id = d.clash.startsWith(`${scope}/mint:`)
        ? d.clash.slice(`${scope}/mint:`.length)
        : null;
      if (!id || !p.mints.includes(id)) continue;
      p.mints = p.mints.filter((m) => m !== id);
      const st = g.stored(id);
      if (!st) continue;
      const m = member(st, "live", handleOf(st.label ?? ""));
      p.clashes.push({
        key: d.clash,
        ref: "",
        kind: "mint",
        handle: handleOf(st.label ?? ""),
        members: [m],
        proposal: "unclear",
        evidence: [],
        digest: digestOf("mint", [m]),
        options: [],
      });
    }
    const applied = await apply(g, p, decisions, run);
    let refs2 = checkRefs(g, refs, legacy, pre);
    // A reference this run broke takes back the write that broke it.
    for (const ch of refs2.filter((x) => x.outcome === "migration-break" && x.after)) {
      const owner = p.clashes.find((c) => c.members.some((m) => m.id === ch.after));
      const r = owner
        ? await g.revertBatch({ run, clash: owner.key })
        : await g.revertBatch({ run, record: ch.after as string });
      applied.rowsReverted += r.removed;
      applied.failed.push({
        clash: owner?.key ?? `${scope}/mint:${ch.after}`,
        reason: `would break ${REFERENCE_PREFIX}${ch.ref}`,
      });
      if (owner) applied.applied = applied.applied.filter((k) => k !== owner.key);
    }
    refs2 = checkRefs(g, refs, legacy, pre);
    const n = (sql: string) => (g.db.prepare(sql).get(run) as { n: number }).n;
    applied.minted = n(
      "SELECT count(*) AS n FROM handles WHERE kind = 'handle' AND json_extract(origin, '$.run') = ?",
    );
    applied.merges = n(
      "SELECT count(*) AS n FROM handles WHERE kind = 'merge' AND json_extract(origin, '$.run') = ?",
    );
    applied.rowsWritten = n(
      "SELECT count(*) AS n FROM triples WHERE json_extract(origin, '$.run') = ?",
    );
    return { ...p, refs: refs2, before, after: counts(g), applied };
  } finally {
    g.close();
  }
}

/** A fresh run id: every apply has its own, so reverting one never touches another. */
export const newRun = () => randomUUID();

/**
 * Turn letter choices (`c3=A c5=Q:"Sam (Acme)"`) into decisions, against the full report of the dry run they were
 * made from. A letter names one of that clash's options; `Q:"<label>"` qualifies the clash's designated member.
 */
export function chosen(
  report: Report,
  choices: string,
): { decisions: Decision[]; problems: string[] } {
  const clashes = report.scopes.flatMap((s) => s.clashes);
  const decisions: Decision[] = [];
  const problems: string[] = [];
  for (const m of choices.matchAll(/(c\d+)=(?:Q:"([^"]*)"|([A-Z]))/g)) {
    const c = clashes.find((x) => x.ref === m[1]);
    if (!c) {
      problems.push(`${m[1]} isn't in this report`);
      continue;
    }
    if (m[2] !== undefined) {
      const target = c.qualifyTarget;
      const qualifies = (o: Option) => {
        const ch = target ? o.decision.members?.[target] : undefined;
        return typeof ch === "object" && "qualify" in ch;
      };
      const base = c.options.find(qualifies);
      if (!target || !base) {
        problems.push(`${m[1]} has no member to qualify`);
        continue;
      }
      decisions.push({
        ...base.decision,
        members: { ...base.decision.members, [target]: { qualify: m[2] } },
      });
      continue;
    }
    const o = c.options.find((x) => x.letter === m[3]);
    if (!o) problems.push(`${m[1]} has no option ${m[3]}`);
    else decisions.push(o.decision);
  }
  const unparsed = choices.replace(/(c\d+)=(?:Q:"[^"]*"|[A-Z])/g, "").trim();
  if (unparsed) problems.push(`couldn't read: ${unparsed}`);
  return { decisions, problems };
}

/** Number the clashes across scopes (c1, c2, ...) in a stable order, for choosing by letter. */
export function numbered(report: Report): Report {
  let i = 0;
  for (const s of report.scopes) for (const c of s.clashes) c.ref = `c${++i}`;
  return report;
}

const q = (v: string) => JSON.stringify(v);

/**
 * The report as it may leave the host: counts, clashes by handle and record id, types, which details there are and
 * whether members agree on each, who wrote them and when. Never a detail's value; names are handles and ids only.
 */
export function redacted(report: Report): string {
  const out = [
    `eve-memory-migrate ${report.version} mode=${report.mode} dir=${q(report.dir)} scopes=${report.scopes.length}`,
  ];
  for (const s of report.scopes) {
    const c = (x?: Counts) =>
      x ? `records=${x.records} edges=${x.edges} triples=${x.triples} handles=${x.handles}` : "";
    out.push(
      `scope=${q(s.scope)} ${c(s.before)}${s.after ? ` → ${c(s.after)}` : ""} clashes=${s.clashes.length} mints=${s.mints.length} unnamed=${s.unnamed.length}`,
    );
    for (const cl of s.clashes) {
      out.push(
        `  ${cl.ref} ${cl.kind} ${REFERENCE_PREFIX}${cl.handle} proposal=${cl.proposal} digest=${cl.digest}`,
      );
      const keys = [...new Set(cl.members.flatMap((m) => m.keys))].sort();
      for (const m of cl.members) {
        const agree = keys
          .map((k) =>
            !m.keys.includes(k)
              ? `${k}:-`
              : !cl.members.some((o) => o !== m && o.keys.includes(k))
                ? `${k}:only`
                : cl.members.every(
                      (o) => o === m || !o.keys.includes(k) || o.values[k] === m.values[k],
                    )
                  ? `${k}:same`
                  : `${k}:differs`,
          )
          .join(",");
        out.push(
          `    ${m.id} ${m.state} type=${m.type ?? "-"} holds=${m.holds} edges=${m.edges.length} details=${agree || "-"} written=${m.firstWritten ?? "?"}..${m.lastWritten ?? "?"} by=${m.writers.join("+")}`,
        );
      }
      for (const o of cl.options)
        out.push(
          `    ${o.letter}: ${o.summary}${o.ok ? "" : ` (won't apply: ${o.problems.join("; ")})`}`,
        );
    }
    const breaks = s.refs.filter((r) => r.outcome !== "ok");
    out.push(
      `  refs=${s.refs.length} pin_breaks=${breaks.filter((r) => r.outcome === "pin-break").length} migration_breaks=${breaks.filter((r) => r.outcome === "migration-break").length}`,
    );
    for (const r of breaks)
      out.push(
        `    ${r.outcome} ${REFERENCE_PREFIX}${r.ref} ${r.legacy ?? "-"}/${r.before ?? "-"} → ${r.after ?? "-"}`,
      );
    if (s.applied) {
      const a = s.applied;
      out.push(
        `  run=${a.run} applied=${a.applied.length} skipped=${a.skipped.length} failed=${a.failed.length} merges=${a.merges} minted=${a.minted} rows_written=${a.rowsWritten} rows_reverted=${a.rowsReverted}`,
      );
      for (const x of [
        ...a.skipped.map((x) => ["skipped", x] as const),
        ...a.failed.map((x) => ["failed", x] as const),
      ])
        out.push(`    ${x[0]} ${x[1].clash}: ${x[1].reason}`);
    }
  }
  return out.join("\n");
}
