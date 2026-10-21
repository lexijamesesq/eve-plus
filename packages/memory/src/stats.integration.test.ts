import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { MemoryGraph } from "./memory-graph.js";
import {
  type FileStat,
  findings,
  formatStats,
  openReadOnly,
  scopeStats,
  scopesIn,
} from "./stats.js";

const dirs: string[] = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "eve-plus-stats-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// A memory directory with one scope holding a few facts, the way the provider lays it out.
async function memoryDir(scope = "memscope1_alice") {
  const dir = tempDir();
  const g = await MemoryGraph.create({ dir: join(dir, scope) });
  await g.remember({ id: "kettle", label: "Kettle", type: "Thing", attributes: { colour: "red" } });
  await g.remember({
    id: "mug",
    label: "Mug",
    type: "Thing",
    relations: [{ relation: "near", to: "kettle" }],
  });
  await g.forget({ id: "kettle", details: ["colour"] });
  return { dir, g };
}

const hash = (path: string) =>
  existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : "absent";

describe("a 0.3 store opened by 0.4 gets a high-water mark seeded from its rows", () => {
  it("seeds seq_hwm from max(seq) and moves to user_version 4", async () => {
    const dir = tempDir();
    const db = new Database(join(dir, "graph.db"));
    db.exec(`CREATE TABLE triples(s TEXT, p TEXT, o TEXT, ot TEXT, dt TEXT, written_at TEXT, origin TEXT, seq INTEGER);
             CREATE VIRTUAL TABLE lit_fts USING fts5(s UNINDEXED, o);
             CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
             INSERT INTO triples VALUES ('https://eve.local/mem/e/a','https://eve.local/mem/p/n','x','lit',NULL,'','{}',41);
             PRAGMA user_version = 3;`);
    db.close();
    expect(scopeStats(dir, ".").seqHwm).toBeNull();
    const g = await MemoryGraph.create({ dir });
    g.close();
    expect(scopeStats(dir, ".")).toMatchObject({ userVersion: 4, seqHwm: 41, maxSeq: 41 });
  });
});

describe("eve-memory-stats reports each store's facts", () => {
  it("finds every subdirectory holding a graph.db, whatever its name", async () => {
    const { dir, g } = await memoryDir();
    g.close();
    mkdirSync(join(dir, "not-a-store"));
    const other = await MemoryGraph.create({ dir: join(dir, "renamed-scope") });
    other.close();
    expect(scopesIn(dir)).toEqual(["memscope1_alice", "renamed-scope"]);
  });

  it("reports the mark, the check, current facts, tombstones and a matching index", async () => {
    const { dir, g } = await memoryDir();
    const s = scopeStats(dir, "memscope1_alice");
    g.close();
    expect(s).toMatchObject({ userVersion: 4, quickCheck: "ok", tombstones: 1 });
    expect(s.seqHwm).toBe(s.maxSeq);
    // kettle: type, label; mug: type, label, the edge
    expect(s.currentFacts).toBe(5);
    expect(s.searchIndex).toEqual({ indexed: 2, current: 2, missing: 0, extra: 0 });
    expect(findings(s)).toEqual([]);
  });

  it("formats one line per scope for the deploy log", async () => {
    const { dir, g } = await memoryDir();
    g.close();
    const text = formatStats(
      dir,
      scopesIn(dir).map((s) => scopeStats(dir, s)),
      "0.4.0",
    );
    const [header, line] = text.split("\n");
    expect(header).toBe(`eve-memory-stats 0.4.0 dir=${JSON.stringify(dir)} scopes=1`);
    expect(line).toMatch(
      /^scope="memscope1_alice" user_version=4 seq_hwm=\d+ max_seq=\d+ quick_check="ok" /,
    );
    expect(line).toMatch(/ search_index=2\/2 missing=0 extra=0 files=graph\.db:\d+:\d+:\d+/);
    expect(line).toMatch(/ findings=none$/);
  });
});

describe("it can fail: each known-bad store is reported", () => {
  it("an emptied search index", async () => {
    const { dir, g } = await memoryDir();
    g.db.exec("DELETE FROM lit_fts");
    g.close();
    const s = scopeStats(dir, "memscope1_alice");
    expect(s.searchIndex).toEqual({ indexed: 0, current: 2, missing: 2, extra: 0 });
    expect(findings(s).join()).toContain(
      "search index out of step: 2 current value(s) not indexed",
    );
  });

  it("a removed scope is absent from the next report", async () => {
    const { dir, g } = await memoryDir();
    g.close();
    expect(scopesIn(dir)).toEqual(["memscope1_alice"]);
    rmSync(join(dir, "memscope1_alice"), { recursive: true });
    expect(scopesIn(dir)).toEqual([]);
    expect(formatStats(dir, [], "0.4.0")).toContain("scopes=0");
  });

  it("a file the agent's user doesn't own", async () => {
    const { dir, g } = await memoryDir();
    g.close();
    const owner = (file: string): FileStat => ({
      file,
      uid: file.endsWith("-shm") ? 0 : 1000,
      gid: file.endsWith("-shm") ? 0 : 1000,
      mode: 0o644,
    });
    const s = scopeStats(dir, "memscope1_alice", { uid: 1000, stat: owner });
    expect(findings(s).join("\n")).toContain(
      "ownership: graph.db-shm owned by 0:0, not 1000:1000 like graph.db",
    );
  });

  // Root enters any directory whatever its mode, so the case only exists for an ordinary user.
  it.skipIf(process.getuid?.() === 0)(
    "a scope directory that can't be entered is reported as unreadable, not taken for a removed scope",
    async () => {
      const { dir, g } = await memoryDir();
      g.close();
      chmodSync(join(dir, "memscope1_alice"), 0o000);
      try {
        expect(scopesIn(dir)).toEqual(["memscope1_alice"]);
        const s = scopeStats(dir, "memscope1_alice");
        expect(findings(s)[0]).toMatch(/^unreadable: /);
        expect(s.ownership.join()).toContain("can't be examined (EACCES)");
      } finally {
        chmodSync(join(dir, "memscope1_alice"), 0o755);
      }
    },
  );

  it("a symlinked scope directory counts as a scope", async () => {
    const { dir, g } = await memoryDir();
    g.close();
    const elsewhere = tempDir();
    cpSync(join(dir, "memscope1_alice"), join(elsewhere, "real"), { recursive: true });
    symlinkSync(join(elsewhere, "real"), join(dir, "linked"));
    expect(scopesIn(dir)).toEqual(["linked", "memscope1_alice"]);
    expect(findings(scopeStats(dir, "linked"))).toEqual([]);
  });

  it("a store that isn't a database is unreadable, not skipped", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "broken"));
    cpSync(new URL(import.meta.url), join(dir, "broken", "graph.db"));
    const s = scopeStats(dir, "broken");
    expect(s.error).toBeDefined();
    expect(findings(s)[0]).toMatch(/^unreadable: /);
  });
});

describe("read-only: it never writes the store or its WAL, even with a live writer", () => {
  it("opens a store that refuses writes", async () => {
    const { dir, g } = await memoryDir();
    g.close();
    const db = openReadOnly(join(dir, "memscope1_alice", "graph.db"));
    try {
      expect(db.readonly).toBe(true);
      expect(() => db.exec("CREATE TABLE probe(a)")).toThrow(/readonly/);
    } finally {
      db.close();
    }
  });

  it("leaves graph.db and graph.db-wal byte-identical while the writer holds the store open", async () => {
    const { dir, g } = await memoryDir();
    // The writer is still open and its WAL is not checkpointed: the state a running agent leaves.
    const at = join(dir, "memscope1_alice");
    const db = join(at, "graph.db");
    expect(existsSync(`${db}-wal`)).toBe(true);
    const before = [hash(db), hash(`${db}-wal`)];
    const s = scopeStats(dir, "memscope1_alice");
    expect(s.quickCheck).toBe("ok");
    expect([hash(db), hash(`${db}-wal`)]).toEqual(before);
    // The writer still works afterwards.
    await g.remember({ id: "teapot", label: "Teapot", type: "Thing" });
    g.close();
  });

  it("leaves a cleanly closed store's graph.db byte-identical, with at most an empty WAL beside it", async () => {
    const { dir, g } = await memoryDir();
    g.close();
    const db = join(dir, "memscope1_alice", "graph.db");
    expect(existsSync(`${db}-wal`)).toBe(false);
    const before = hash(db);
    expect(scopeStats(dir, "memscope1_alice").quickCheck).toBe("ok");
    expect(hash(db)).toBe(before);
    if (existsSync(`${db}-wal`)) expect(readFileSync(`${db}-wal`).length).toBe(0);
  });

  it("doesn't migrate an older store: its user_version and missing mark stay as they were", async () => {
    const dir = tempDir();
    const db = new Database(join(dir, "graph.db"));
    db.exec(`CREATE TABLE triples(s TEXT, p TEXT, o TEXT, ot TEXT, dt TEXT, written_at TEXT, origin TEXT, seq INTEGER);
             CREATE VIRTUAL TABLE lit_fts USING fts5(s UNINDEXED, o);
             CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
             PRAGMA user_version = 3;`);
    db.close();
    const before = hash(join(dir, "graph.db"));
    expect(scopeStats(dir, ".")).toMatchObject({ userVersion: 3, seqHwm: null });
    expect(hash(join(dir, "graph.db"))).toBe(before);
  });
});
