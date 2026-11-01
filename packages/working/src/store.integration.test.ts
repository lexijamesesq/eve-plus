import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import type { SessionAuthContext } from "eve/context";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import type { Address } from "./addresses.js";
import { type Origin, SCHEMA_VERSION, WorkingStore, workingStorePath } from "./store.js";

const operator: Origin = { principalId: "U-alice", kind: "operator", sessionId: "s1" };
const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "working-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const slack = (channel: string, thread: string): SessionAuthContext => ({
  principalId: "U-alice",
  principalType: "user",
  authenticator: "slack-webhook",
  attributes: { channel_id: channel, thread_ts: thread, team_id: "T1" },
});
// The host's resolver, as a baseline would write it: a DM is its channel, any other Slack channel its thread.
const resolve = (p: SessionAuthContext): Address | null => {
  const {
    channel_id: channelId,
    thread_ts: threadTs,
    team_id: teamId,
  } = p.attributes as Record<string, string>;
  if (p.authenticator !== "slack-webhook" || !channelId || !teamId) return null;
  return channelId.startsWith("D")
    ? { kind: "slack-dm", teamId, channelId }
    : { kind: "slack-thread", teamId, channelId, threadTs: threadTs ?? "" };
};

// The baseline follow-ups store's own schema, so the import reads the file it will meet.
const FOLLOWUPS_SCHEMA = `
CREATE TABLE followups (
  id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, thread_ts TEXT NOT NULL, principal TEXT NOT NULL,
  due_at INTEGER, on_event TEXT, note TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'cancelled')),
  lease_until INTEGER, lease_token TEXT, fired_by TEXT, created_at INTEGER NOT NULL, settled_at INTEGER
);`;
function followupsFile(dir: string): string {
  const path = join(dir, "followups.sqlite");
  const db = new DatabaseSync(path);
  db.exec(FOLLOWUPS_SCHEMA);
  const add = db.prepare(
    "INSERT INTO followups (id, channel_id, thread_ts, principal, due_at, on_event, note, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  add.run(
    "f1",
    "D1",
    "1.1",
    JSON.stringify(slack("D1", "1.1")),
    2_000,
    null,
    "check the digest\nthen deploy zero",
    "pending",
    1_000,
  );
  add.run(
    "f2",
    "C1",
    "2.2",
    JSON.stringify(slack("C1", "2.2")),
    null,
    "deploy-completed:ollie",
    "ask Ollie",
    "pending",
    1_000,
  );
  add.run("f3", "C1", "3.3", JSON.stringify(slack("C1", "3.3")), 1_500, null, "old", "done", 1_000);
  add.run(
    "f4",
    "C1",
    "4.4",
    JSON.stringify(slack("C1", "4.4")),
    1_500,
    null,
    "never mind",
    "cancelled",
    1_000,
  );
  const linear = { ...slack("C1", "5.5"), authenticator: "linear-webhook" };
  add.run("f5", "C1", "5.5", JSON.stringify(linear), 1_500, null, "elsewhere", "pending", 1_000);
  db.close();
  return path;
}

describe("on disk", () => {
  it("a store survives a restart at the current schema version", () => {
    const dir = tempDir();
    const path = workingStorePath(join(dir, "nested"));
    const s = new WorkingStore(path);
    const r = s.open(
      {
        address: { kind: "named", name: "x" },
        principal: null,
        what: "w",
        waitingOn: "me",
        next: "n",
      },
      operator,
    );
    s.close();
    const again = new WorkingStore(path);
    expect(again.list({ view: "all" }).loops.map((l) => l.id)).toEqual([r.ok && r.loop.id]);
    again.close();
    const raw = new DatabaseSync(path, { readOnly: true });
    expect(raw.prepare("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
    raw.close();
  });
});

describe("migrateFollowups", () => {
  it("imports a follow-ups file once: pending, done and cancelled mapped, unplaceable rows counted", () => {
    const dir = tempDir();
    const source = followupsFile(dir);
    const s = new WorkingStore(workingStorePath(dir), { now: () => 1_800 });
    expect(s.migrateFollowups(source, resolve)).toEqual({ imported: 4, skipped: 0, unresolved: 1 });
    const loops = s.list({ view: "all" }).loops;
    const dm = loops.find((l) => l.address.kind === "slack-dm");
    expect(dm).toMatchObject({
      what: "check the digest",
      next: "then deploy zero",
      followupNote: "check the digest\nthen deploy zero",
      dueAt: 2_000,
      wake: "pending",
      origin: { principalId: "U-alice", kind: "other" },
    });
    expect(loops.find((l) => l.onEvent === "deploy-completed:ollie")?.address).toEqual({
      kind: "slack-thread",
      teamId: "T1",
      channelId: "C1",
      threadTs: "2.2",
    });
    expect(s.list({ view: "all", limit: 200 }).totals.loops).toBe(2);
    expect(s.migrateFollowups(source, resolve)).toEqual({ imported: 0, skipped: 4, unresolved: 1 });
    expect(s.list({ view: "all" }).totals.loops).toBe(2);
    // The imported wake still fires: due, then claimed with the follow-up's principal to send as.
    const [claimed] = s.claimDue(2_000, 60_000);
    expect(claimed).toMatchObject({ address: { kind: "slack-dm" }, principal: slack("D1", "1.1") });
    // The event loop keeps the old store's guard: an event before it was scheduled wakes nothing.
    expect(s.eventOccurred("deploy-completed:ollie", 999, "old run", 2_000)).toBe(0);
    expect(s.eventOccurred("deploy-completed:ollie", 1_000, "run 7", 2_000)).toBe(1);
    s.close();
  });

  it("a missing follow-ups file imports nothing", () => {
    const dir = tempDir();
    const s = new WorkingStore(workingStorePath(dir));
    expect(s.migrateFollowups(join(dir, "absent.sqlite"), resolve)).toEqual({
      imported: 0,
      skipped: 0,
      unresolved: 0,
    });
    s.close();
  });
});

// Real overlapping ticks: each worker opens its own connection to one file and claims in a tight loop. The compiled
// store goes to a scratch directory inside the package, so the workers resolve its dependencies as a consumer would.
describe("claimDue under concurrent ticks", () => {
  const scratch = join(import.meta.dirname, "..", ".mut");
  mkdirSync(scratch, { recursive: true });
  const out = mkdtempSync(join(scratch, "workers-"));
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it("claimDue claims each row once under concurrent ticks", async () => {
    execFileSync(
      process.execPath,
      [
        join(import.meta.dirname, "..", "node_modules", "typescript", "bin", "tsc"),
        "-p",
        "tsconfig.build.json",
        "--outDir",
        out,
      ],
      { cwd: join(import.meta.dirname, "..") },
    );
    const dir = tempDir();
    const path = workingStorePath(dir);
    const s = new WorkingStore(path, { now: () => 1_000 });
    const ROWS = 60;
    for (let i = 0; i < ROWS; i++)
      s.open(
        {
          address: { kind: "named", name: `n${i}` },
          principal: null,
          what: "w",
          waitingOn: "me",
          next: "n",
          revisit: { dueAt: 1_000 },
        },
        operator,
      );
    s.close();
    const code = `
      const { parentPort, workerData } = require("node:worker_threads");
      import(workerData.module).then(({ WorkingStore }) => {
        const s = new WorkingStore(workerData.path);
        const ids = [];
        for (let i = 0; i < 40; i++) for (const c of s.claimDue(2_000, 600_000)) ids.push(c.id);
        s.close();
        parentPort.postMessage(ids);
      });`;
    const claims = await Promise.all(
      Array.from(
        { length: 6 },
        () =>
          new Promise<string[]>((done, fail) => {
            const w = new Worker(code, {
              eval: true,
              workerData: { module: `file://${join(out, "store.js")}`, path },
            });
            w.once("message", done);
            w.once("error", fail);
          }),
      ),
    );
    const all = claims.flat();
    expect(all).toHaveLength(ROWS);
    expect(new Set(all).size).toBe(ROWS);
  }, 30_000);
});
