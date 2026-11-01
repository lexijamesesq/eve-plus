// Read-only facts about a working store on disk, for telling whether it survived a deploy. The store is opened with
// `readOnly`, never through WorkingStore (which migrates and writes), so this never writes working.sqlite or its WAL.
// SQLite may create working.sqlite-shm, owned by whoever runs this.

import { statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { STORE_FILE } from "./store.js";

const STORE = STORE_FILE;
const FILES = [STORE, `${STORE}-wal`, `${STORE}-shm`];

export interface FileStat {
  file: string;
  uid: number;
  gid: number;
  mode: number;
}

export interface StoreStats {
  userVersion?: number;
  quickCheck?: string;
  loops?: { open: number; delivering: number; done: number; dropped: number };
  orders?: { active: number; lifted: number; replaced: number };
  notes?: number;
  stale?: { loops: number; orders: number };
  wakes?: { pending: number; undeliverable: number };
  files: FileStat[];
  /** Files whose owner differs from working.sqlite's or from the running user's, or that their owner can't read and write. */
  ownership: string[];
  /** Set when the store couldn't be read at all: itself a finding. */
  error?: string;
}

export interface StatsOptions {
  /** The file stat to use; tests inject one. */
  stat?: (path: string) => FileStat | undefined;
  /** The running user's id; tests inject one. */
  uid?: number;
  /** The clock staleness is judged by. */
  now?: number;
}

// Only a file that isn't there is absent. Any other error (a directory the user can't enter) is thrown, so it's
// reported rather than mistaken for a missing store.
const statOrAbsent = (path: string) => {
  try {
    return statSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

const realStat = (path: string): FileStat | undefined => {
  const s = statOrAbsent(path);
  return s && { file: path, uid: s.uid, gid: s.gid, mode: s.mode & 0o7777 };
};

/** Whether `dir` holds a working store. */
export const holdsStore = (dir: string): boolean => statOrAbsent(join(dir, STORE)) !== undefined;

export function storeStats(dir: string, options: StatsOptions = {}): StoreStats {
  const stat = options.stat ?? realStat;
  const uid = options.uid ?? process.getuid?.();
  const now = options.now ?? Date.now();
  const stats: StoreStats = { files: [], ownership: [] };
  try {
    const db = new DatabaseSync(join(dir, STORE), { readOnly: true });
    try {
      const n = (sql: string, ...params: number[]) =>
        Number((db.prepare(sql).get(...params) as { n: number }).n);
      stats.userVersion = Number(
        (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      );
      stats.quickCheck = String(
        (db.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check,
      );
      const loops = (status: string) =>
        n(`SELECT count(*) AS n FROM loops WHERE status = '${status}'`);
      stats.loops = {
        open: loops("open"),
        delivering: loops("delivering"),
        done: loops("done"),
        dropped: loops("dropped"),
      };
      const orders = (status: string) =>
        n(`SELECT count(*) AS n FROM orders WHERE status = '${status}'`);
      stats.orders = {
        active: orders("active"),
        lifted: orders("lifted"),
        replaced: orders("replaced"),
      };
      stats.notes = n("SELECT count(*) AS n FROM notes WHERE expires_at > ?", now);
      stats.stale = {
        loops: n(
          "SELECT count(*) AS n FROM loops WHERE status IN ('open', 'delivering') AND review_by <= ?",
          now,
        ),
        orders: n(
          "SELECT count(*) AS n FROM orders WHERE status = 'active' AND (review_by <= ? OR until <= ?)",
          now,
          now,
        ),
      };
      const wakes = (state: string) =>
        n(
          `SELECT count(*) AS n FROM loops WHERE status IN ('open', 'delivering') AND wake = '${state}'`,
        );
      stats.wakes = { pending: wakes("pending"), undeliverable: wakes("undeliverable") };
    } finally {
      db.close();
    }
  } catch (error) {
    stats.error = error instanceof Error ? error.message : String(error);
  }
  // After the open, so a -shm this run created is what's reported.
  for (const file of FILES) {
    try {
      const s = stat(join(dir, file));
      if (s) stats.files.push({ ...s, file });
    } catch (error) {
      stats.ownership.push(
        `${file} can't be examined (${(error as NodeJS.ErrnoException).code ?? error})`,
      );
    }
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

/** Findings within one snapshot. Comparing snapshots (fewer open loops, a lower version) is the reader's. */
export function findings(s: StoreStats): string[] {
  const out: string[] = [];
  if (s.error) out.push(`unreadable: ${s.error}`);
  if (s.quickCheck !== undefined && s.quickCheck !== "ok") out.push(`quick_check: ${s.quickCheck}`);
  for (const o of s.ownership) out.push(`ownership: ${o}`);
  return out;
}

const q = (v: string) => JSON.stringify(v);

/** The report's first line, for a full report or one that stops at the directory (`error`). */
export function statsHeader(dir: string, version: string, stores: number, error?: string): string {
  return `eve-working-stats ${version} dir=${q(dir)} stores=${stores}${error === undefined ? "" : ` error=${q(error)}`}`;
}

/** The header, then one `key=value` line for the store, for a deploy log. */
export function formatStats(dir: string, s: StoreStats | undefined, version: string): string {
  if (s === undefined) return statsHeader(dir, version, 0);
  const fields = [`store=${q(STORE)}`];
  if (s.error === undefined) {
    fields.push(
      `user_version=${s.userVersion}`,
      `quick_check=${q(s.quickCheck ?? "")}`,
      `open=${s.loops?.open}`,
      `delivering=${s.loops?.delivering}`,
      `done=${s.loops?.done}`,
      `dropped=${s.loops?.dropped}`,
      `orders_active=${s.orders?.active}`,
      `orders_lifted=${s.orders?.lifted}`,
      `orders_replaced=${s.orders?.replaced}`,
      `notes=${s.notes}`,
      `stale_loops=${s.stale?.loops}`,
      `stale_orders=${s.stale?.orders}`,
      `pending_wakes=${s.wakes?.pending}`,
      `undeliverable_wakes=${s.wakes?.undeliverable}`,
    );
  }
  fields.push(
    `files=${s.files.map((f) => `${f.file}:${f.uid}:${f.gid}:${f.mode.toString(8)}`).join(",") || "none"}`,
  );
  const found = findings(s);
  fields.push(`findings=${found.length ? q(found.join(" | ")) : "none"}`);
  return [statsHeader(dir, version, 1), fields.join(" ")].join("\n");
}
