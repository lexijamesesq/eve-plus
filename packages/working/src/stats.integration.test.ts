import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { formatStats, storeStats } from "./stats.js";
import { type Origin, WorkingStore, workingStorePath } from "./store.js";

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "working-stats-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const origin: Origin = { principalId: "U-alice", kind: "operator", sessionId: "s1" };
const hash = (path: string) =>
  existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : "absent";

function populated() {
  const dir = tempDir();
  const s = new WorkingStore(workingStorePath(dir), { now: () => 1_000 });
  const base = { principal: null, what: "w", waitingOn: "me", next: "n" };
  s.open({ ...base, address: { kind: "named", name: "a" }, revisit: { dueAt: 5_000 } }, origin);
  s.open(
    {
      ...base,
      address: { kind: "named", name: "b" },
      revisit: { dueAt: 5_000 },
      deliverable: false,
    },
    origin,
  );
  const done = s.open({ ...base, address: { kind: "named", name: "c" } }, origin);
  if (done.ok) s.closeLoop(done.loop.id, "done", "ok", origin);
  s.setOrder({ subject: "deploys:ollie", rule: "hold", link: "https://x.test/1" }, origin);
  s.setOrder({ subject: "deploys:felix", rule: "hold", link: "https://x.test/2" }, origin);
  s.liftOrder("deploys:felix", "fixed", origin);
  s.addNote({ text: "note" }, origin);
  s.close();
  return dir;
}

describe("eve-working-stats", () => {
  it("reports one store's counts in the eve-memory-stats line shape", () => {
    const dir = populated();
    const out = formatStats(dir, storeStats(dir, { now: 2_000 }), "0.1.0").split("\n");
    expect(out[0]).toBe(`eve-working-stats 0.1.0 dir=${JSON.stringify(dir)} stores=1`);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatch(
      /^store="working\.sqlite" user_version=1 quick_check="ok" open=2 delivering=0 done=1 dropped=0 orders_active=1 orders_lifted=1 orders_replaced=0 notes=1 stale_loops=0 stale_orders=0 pending_wakes=1 undeliverable_wakes=1 files=\S+ findings=none$/,
    );
  });

  it("marks stale entries by the clock it's given", () => {
    const dir = populated();
    const s = storeStats(dir, { now: 1_000 + 15 * 86_400_000 });
    expect(s.stale).toEqual({ loops: 2, orders: 1 });
  });

  it("never writes the store or its WAL, even with a live writer", () => {
    const dir = populated();
    const db = join(dir, "working.sqlite");
    const writer = new WorkingStore(db);
    writer.addNote({ text: "held open" }, origin);
    const before = [hash(db), hash(`${db}-wal`)];
    storeStats(dir);
    expect([hash(db), hash(`${db}-wal`)]).toEqual(before);
    writer.close();
    // A cleanly closed store has no WAL; reading it may leave an empty one, never a written one.
    const closed = hash(db);
    storeStats(dir);
    expect(hash(db)).toBe(closed);
    if (existsSync(`${db}-wal`)) expect(readFileSync(`${db}-wal`).length).toBe(0);
  });

  it("an unreadable store is a finding, not a crash", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "working.sqlite"), "not a database");
    const out = formatStats(dir, storeStats(dir), "0.1.0");
    expect(out).toMatch(/stores=1\nstore="working\.sqlite" files=\S+ findings="unreadable: /);
  });
});
