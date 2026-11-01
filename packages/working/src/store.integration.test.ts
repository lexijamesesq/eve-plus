import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import type { SessionAuthContext } from "eve/context";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import {
  type ImportedLoop,
  LOOP_WAKE_OPENING,
  type Origin,
  openWorkingStore,
  SCHEMA_VERSION,
  WorkingStore,
  workingStorePath,
} from "./store.js";

const operator: Origin = { principalId: "U-alice", kind: "operator", sessionId: "s1" };
const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "working-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

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

describe("importLoop", () => {
  const alice: SessionAuthContext = {
    principalId: "U-alice",
    principalType: "user",
    authenticator: "slack-webhook",
    attributes: { channel_id: "D1", thread_ts: "1.1", team_id: "T1", email: "alice@example.test" },
  };
  const imported = (externalId: string, extra: Partial<ImportedLoop> = {}): ImportedLoop => ({
    externalId,
    address: { kind: "slack-dm", teamId: "T1", channelId: "D1" },
    principal: alice,
    what: "check the notes",
    next: "then publish the release",
    status: "open",
    wake: { dueAt: 2_000 },
    createdAt: 1_000,
    origin: { principalId: "U-alice", kind: "other", sessionId: null },
    ...extra,
  });

  it("brings a loop in once, stored as open would store it, and its wake fires", () => {
    const dir = tempDir();
    const s = openWorkingStore({ dir, now: () => 1_800 });
    expect(s.importLoop(imported("f1"))).toBe("imported");
    expect(s.importLoop(imported("f1", { what: "changed" }))).toBe("exists");
    expect(s.importLoop(imported("f2", { status: "done", wake: { dueAt: 1_500 } }))).toBe(
      "imported",
    );
    const [loop] = s.list({ view: "all" }).loops;
    expect(loop).toMatchObject({
      what: "check the notes",
      next: "then publish the release",
      wake: "pending",
    });
    expect(s.list({ view: "all" }).totals.loops).toBe(1);
    const [claimed] = s.claimDue(2_000, 60_000);
    expect(claimed?.followupNote).toMatch(
      new RegExp(
        `^${LOOP_WAKE_OPENING} \\(${loop?.id}, opened .*\\): check the notes\nNext: then publish the release\n`,
      ),
    );
    expect(claimed?.principal?.attributes).toEqual({
      channel_id: "D1",
      thread_ts: "1.1",
      team_id: "T1",
    });
    s.close();
  });

  it("a row with a bad time is refused alone, and open rows past the cap are capped", () => {
    const s = openWorkingStore({ dir: tempDir(), limits: { loops: 1 } });
    expect(s.importLoop(imported("bad", { createdAt: Number.NaN }))).toBe("bad");
    expect(s.importLoop(imported("f1"))).toBe("imported");
    expect(s.importLoop(imported("f2"))).toBe("capped");
    expect(s.importLoop(imported("f3", { status: "done" }))).toBe("imported");
    s.close();
  });

  it("an imported event wake keeps the guard: an old event from before it was set wakes nothing", () => {
    const s = openWorkingStore({ dir: tempDir() });
    s.importLoop(imported("f3", { wake: { onEvent: "build-finished:api" } }));
    expect(s.eventOccurred("build-finished:api", 999, "old run", 1_000 + 30 * 60_000)).toBe(0);
    expect(s.eventOccurred("build-finished:api", 1_000, "run 7", 1_000 + 30 * 60_000)).toBe(1);
    s.close();
  });

  it("onFirstOpen runs before the store is returned, and a throw from it never fails the open", () => {
    const dir = tempDir();
    const s = openWorkingStore({ dir, onFirstOpen: (store) => store.importLoop(imported("f4")) });
    expect(s.list({ view: "all" }).totals.loops).toBe(1);
    s.close();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const again = openWorkingStore({
      dir,
      onFirstOpen: () => {
        throw new Error("source unreadable");
      },
    });
    expect(again.list({ view: "all" }).totals.loops).toBe(1);
    expect(warn).toHaveBeenCalledWith("[working] onFirstOpen failed: source unreadable");
    again.close();
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
        createRequire(import.meta.url).resolve("typescript/bin/tsc"),
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
