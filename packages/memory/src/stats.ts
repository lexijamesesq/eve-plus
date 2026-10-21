// Read-only facts about memory stores on disk, for telling whether a store survived a deploy. It opens each store
// with `readonly: true`, never through MemoryGraph.create (which migrates and writes), so it never writes graph.db
// or its WAL. SQLite may create or touch the -shm file, owned by whoever runs this.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

import { CURRENT_FACTS_SQL, CURRENT_LITERALS_SQL, SEQ_HWM_SQL } from "./memory-graph.js";

const STORE = "graph.db";
const FILES = [STORE, `${STORE}-wal`, `${STORE}-shm`];

/** A store opened so nothing can write it: never migrated or checkpointed, unlike MemoryGraph.create. */
export const openReadOnly = (path: string): Database.Database =>
  new Database(path, { readonly: true, fileMustExist: true });

export interface FileStat {
  file: string;
  uid: number;
  gid: number;
  mode: number;
}

export interface ScopeStats {
  /** The scope's directory name, or "." for a store at the top of the directory. */
  scope: string;
  userVersion?: number;
  /** The persisted write high-water mark; null for a store no 0.4+ adapter has opened. */
  seqHwm?: number | null;
  maxSeq?: number;
  quickCheck?: string;
  currentFacts?: number;
  tombstones?: number;
  searchIndex?: { indexed: number; current: number; missing: number; extra: number };
  files: FileStat[];
  /** Files whose owner differs from graph.db's or from the running user's, or that their owner can't read and write. */
  ownership: string[];
  /** Set when the store couldn't be read at all: itself a finding. */
  error?: string;
}

export interface StatsOptions {
  /** The file stat to use; tests inject one. */
  stat?: (path: string) => FileStat | undefined;
  /** The running user's id; tests inject one. */
  uid?: number;
}

const realStat = (path: string): FileStat | undefined => {
  if (!existsSync(path)) return undefined;
  const { uid, gid, mode } = statSync(path);
  return { file: path, uid, gid, mode: mode & 0o7777 };
};

/** Every store under `dir`: `dir` itself if it holds graph.db, then each direct subdirectory that does. */
export function scopesIn(dir: string): string[] {
  const scopes = existsSync(join(dir, STORE)) ? ["."] : [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  ))
    if (entry.isDirectory() && existsSync(join(dir, entry.name, STORE))) scopes.push(entry.name);
  return scopes;
}

export function scopeStats(dir: string, scope: string, options: StatsOptions = {}): ScopeStats {
  const stat = options.stat ?? realStat;
  const uid = options.uid ?? process.getuid?.();
  const at = join(dir, scope);
  const stats: ScopeStats = { scope, files: [], ownership: [] };
  try {
    const db = openReadOnly(join(at, STORE));
    try {
      stats.userVersion = db.pragma("user_version", { simple: true }) as number;
      stats.quickCheck = String(db.pragma("quick_check", { simple: true }));
      const hasMeta = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
        .get();
      stats.seqHwm = hasMeta
        ? ((db.prepare(SEQ_HWM_SQL).get() as { n: number } | undefined)?.n ?? null)
        : null;
      stats.maxSeq = (
        db.prepare("SELECT ifnull(max(seq), 0) AS n FROM triples").get() as { n: number }
      ).n;
      stats.currentFacts = (db.prepare(CURRENT_FACTS_SQL).get() as { n: number }).n;
      stats.tombstones = (
        db.prepare("SELECT count(*) AS n FROM triples WHERE ot IN ('tomb', 'tomb-edge')").get() as {
          n: number;
        }
      ).n;
      stats.searchIndex = indexParity(db);
    } finally {
      db.close();
    }
  } catch (error) {
    stats.error = error instanceof Error ? error.message : String(error);
  }
  // After the open, so a -shm this run created is what's reported.
  for (const file of FILES) {
    const s = stat(join(at, file));
    if (s) stats.files.push({ ...s, file });
  }
  const owner = stats.files.find((f) => f.file === STORE);
  for (const f of stats.files) {
    const problems = [];
    if (owner && (f.uid !== owner.uid || f.gid !== owner.gid))
      problems.push(`owned by ${f.uid}:${f.gid}, not ${owner.uid}:${owner.gid} like ${STORE}`);
    if (uid !== undefined && f.uid !== uid)
      problems.push(`owned by ${f.uid}, not the running user ${uid}`);
    if ((f.mode & 0o600) !== 0o600)
      problems.push(`mode ${f.mode.toString(8)} doesn't let its owner read and write it`);
    if (problems.length) stats.ownership.push(`${f.file} ${problems.join("; ")}`);
  }
  return stats;
}

// The search index holds one row per current literal value. Compared as multisets: a value indexed twice or missing
// once is a mismatch even when the totals agree.
function indexParity(db: Database.Database): ScopeStats["searchIndex"] {
  const key = (r: { s: string; o: string }) => `${r.s}\u0000${r.o}`;
  const want = new Map<string, number>();
  let current = 0;
  for (const r of db.prepare(CURRENT_LITERALS_SQL).iterate() as Iterable<{
    s: string;
    o: string;
  }>) {
    want.set(key(r), (want.get(key(r)) ?? 0) + 1);
    current++;
  }
  let indexed = 0;
  let extra = 0;
  for (const r of db.prepare("SELECT s, o FROM lit_fts").iterate() as Iterable<{
    s: string;
    o: string;
  }>) {
    indexed++;
    const n = want.get(key(r)) ?? 0;
    if (n > 0) want.set(key(r), n - 1);
    else extra++;
  }
  let missing = 0;
  for (const n of want.values()) missing += n;
  return { indexed, current, missing, extra };
}

/** Findings within one snapshot. Comparing snapshots (a lower mark, a vanished scope) is the reader's. */
export function findings(s: ScopeStats): string[] {
  const out: string[] = [];
  if (s.error) out.push(`unreadable: ${s.error}`);
  if (s.quickCheck !== undefined && s.quickCheck !== "ok") out.push(`quick_check: ${s.quickCheck}`);
  const i = s.searchIndex;
  if (i && (i.missing > 0 || i.extra > 0))
    out.push(
      `search index out of step: ${i.missing} current value(s) not indexed, ${i.extra} indexed value(s) not current`,
    );
  if (s.seqHwm != null && s.maxSeq !== undefined && s.maxSeq > s.seqHwm)
    out.push(
      `rows past the high-water mark (max seq ${s.maxSeq} > ${s.seqHwm}): an adapter older than 0.4 wrote to it`,
    );
  for (const o of s.ownership) out.push(`ownership: ${o}`);
  return out;
}

const q = (v: string) => JSON.stringify(v);

/** One line per scope, `key=value`, for a deploy log. */
export function formatStats(dir: string, all: ScopeStats[], version: string): string {
  const lines = [`eve-memory-stats ${version} dir=${q(dir)} scopes=${all.length}`];
  for (const s of all) {
    const fields = [`scope=${q(s.scope)}`];
    if (s.error === undefined) {
      fields.push(
        `user_version=${s.userVersion}`,
        `seq_hwm=${s.seqHwm ?? "none"}`,
        `max_seq=${s.maxSeq}`,
        `quick_check=${q(s.quickCheck ?? "")}`,
        `current_facts=${s.currentFacts}`,
        `tombstones=${s.tombstones}`,
        `search_index=${s.searchIndex?.indexed}/${s.searchIndex?.current}` +
          ` missing=${s.searchIndex?.missing} extra=${s.searchIndex?.extra}`,
      );
    }
    fields.push(
      `files=${s.files.map((f) => `${f.file}:${f.uid}:${f.gid}:${f.mode.toString(8)}`).join(",") || "none"}`,
    );
    const found = findings(s);
    fields.push(`findings=${found.length ? q(found.join(" | ")) : "none"}`);
    lines.push(fields.join(" "));
  }
  return lines.join("\n");
}
