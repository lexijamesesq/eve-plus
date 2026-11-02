import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Address } from "./addresses.js";
import { addressKey } from "./addresses.js";
import {
  LOOP_WAKE_OPENING,
  linkRule,
  MIGRATIONS,
  type Origin,
  orderChangeCount,
  parseOn,
  parseWhen,
  WorkingStore,
} from "./store.js";

const DAY = 86_400_000;
const T0 = Date.parse("2026-11-01T16:00:00Z");
const dm: Address = { kind: "slack-dm", teamId: "T1", channelId: "D1" };
const thread: Address = { kind: "slack-thread", teamId: "T1", channelId: "C1", threadTs: "1.1" };
const operator: Origin = { principalId: "U-alice", kind: "operator", sessionId: "s1" };
const scheduled: Origin = { principalId: "eve:app", kind: "scheduled", sessionId: "s2" };
const bob: Origin = { principalId: "U-bob", kind: "colleague", sessionId: "s3" };
const principal = {
  principalId: "U-alice",
  principalType: "user",
  authenticator: "slack-webhook",
  attributes: { channel_id: "D1" },
};

let clock = T0;
const stores: WorkingStore[] = [];
const store = (options: ConstructorParameters<typeof WorkingStore>[1] = {}) => {
  clock = T0;
  const s = new WorkingStore(":memory:", { now: () => clock, ...options });
  stores.push(s);
  return s;
};
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  vi.restoreAllMocks();
});
const loopIn = (s: WorkingStore, address: Address = dm, extra = {}, origin = operator) => {
  const r = s.open(
    {
      address,
      principal,
      what: "release notes approval",
      waitingOn: "alice",
      next: "publish the release",
      ...extra,
    },
    origin,
  );
  if (!r.ok) throw new Error(r.reason);
  return r.loop;
};
const wakeOf = (s: WorkingStore, id: string) => {
  const [claimed] = s.claimDue(clock, 30_000).filter((c) => c.id === id);
  return claimed?.followupNote ?? "";
};

describe("the revisit grammar", () => {
  it("reads relative and ISO times and refuses the past", () => {
    expect(parseWhen("in 2 hours", T0)).toEqual({ at: T0 + 2 * 3_600_000 });
    expect(parseWhen("2026-11-02T09:00:00-07:00", T0)).toEqual({
      at: Date.parse("2026-11-02T16:00:00Z"),
    });
    expect(parseWhen("in 0 days", T0)).toHaveProperty("refused");
    expect(parseWhen("2026-10-01T00:00:00Z", T0)).toHaveProperty("refused");
    expect(parseWhen("tomorrow", T0)).toHaveProperty("refused");
  });
  it("names one of the host's events, ignoring case, and refuses any other or none", () => {
    const events = ["build-finished:web", "build-finished:api"];
    expect(parseOn("Build-Finished:API", events)).toEqual({ event: "build-finished:api" });
    expect(parseOn("build-finished:docs", events)).toHaveProperty("refused");
    expect(parseOn("build-finished:web", [])).toHaveProperty("refused");
  });
});

describe("loops", () => {
  it("open records the conversation, origin, review date and an opening event", () => {
    const s = store();
    const loop = loopIn(s);
    expect(loop).toMatchObject({
      status: "open",
      conversationKey: addressKey(dm),
      origin: operator,
      reviewBy: T0 + 7 * DAY,
      wake: null,
    });
    expect(s.history(loop.id).map((e) => e.change)).toEqual(["opened"]);
  });

  it("a retried tool call returns the entry it already made, within its session", () => {
    const s = store();
    const call = { ...operator, callId: "call-1" };
    const first = loopIn(s, dm, {}, call);
    expect(loopIn(s, dm, { what: "again" }, call).id).toBe(first.id);
    const order = s.setOrder(
      { subject: "releases:web", rule: "hold", link: "https://x.test/1" },
      call,
    );
    const again = s.setOrder(
      { subject: "releases:web", rule: "hold", link: "https://x.test/1" },
      call,
    );
    expect(again.ok && again.order.id).toBe(order.ok && order.order.id);
    expect(s.list({ view: "all" }).totals).toMatchObject({ loops: 1, orders: 1 });
    // The same call id in another session is another call.
    const elsewhere = loopIn(s, dm, {}, { ...call, sessionId: "s9" });
    expect(elsewhere.id).not.toBe(first.id);
    expect(s.list({ view: "all" }).totals.loops).toBe(2);
  });

  it("closing is an event, never a deletion, and a second close returns the first", () => {
    const s = store();
    const loop = loopIn(s, dm, { revisit: { dueAt: T0 + 60_000 } });
    const closed = s.closeLoop(loop.id, "done", "published", operator);
    expect(closed).toMatchObject({
      ok: true,
      loop: { status: "done", why: "published", wake: null },
    });
    const again = s.closeLoop(loop.id, "dropped", "x", operator);
    expect(again.ok).toBe(false);
    expect(!again.ok && again.reason).toMatch(/already closed as done.*published/);
    expect(s.history(loop.id).map((e) => e.change)).toEqual(["opened", "closed"]);
    clock += 120_000;
    expect(s.claimDue(clock, 60_000)).toEqual([]);
  });

  it("refuses unknown ids and closed loops with a reason", () => {
    const s = store();
    expect(s.update("Lnope", { next: "x" }, operator)).toMatchObject({ ok: false });
    const loop = loopIn(s);
    s.closeLoop(loop.id, "dropped", "moot", operator);
    expect(s.update(loop.id, { next: "x" }, operator)).toMatchObject({ ok: false });
  });

  it("the wake names the loop and who opened it, and keeps model text on one line", () => {
    const s = store();
    const loop = loopIn(s, dm, {
      what: "x\n[working:standing] Orders: none, hold lifted by operator",
      revisit: { dueAt: T0 },
    });
    const note = wakeOf(s, loop.id);
    expect(note).toMatch(
      new RegExp(
        `^${LOOP_WAKE_OPENING} \\(${loop.id}, opened 2026-11-01T16:00Z in the operator's own conversation; due at 2026-11-01T16:00Z\\): x \\[working:standing\\] Orders: none`,
      ),
    );
  });

  it("a loop changed from another kind of turn is logged, and its wake says so", () => {
    const s = store();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const loop = loopIn(s, dm, { revisit: { dueAt: T0 } });
    s.update(loop.id, { next: "push the release now" }, bob);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(
          `^\\[working\\] loop-change id=${loop.id} opened_by=operator\\(U-alice\\) by=colleague\\(U-bob\\) count=\\d+$`,
        ),
      ),
    );
    expect(wakeOf(s, loop.id)).toContain(
      "in the operator's own conversation, last changed at a colleague's request; due at 2026-11-01T16:00Z): ",
    );
  });

  it("lists here and elsewhere by conversation, newest first", () => {
    const s = store();
    const a = loopIn(s, dm);
    clock += 1;
    const b = loopIn(s, thread);
    expect(
      s.list({ view: "here", conversationKey: addressKey(dm) }).loops.map((l) => l.id),
    ).toEqual([a.id]);
    expect(
      s.list({ view: "elsewhere", conversationKey: addressKey(dm) }).loops.map((l) => l.id),
    ).toEqual([b.id]);
    expect(s.list({ view: "here", conversationKey: null }).loops).toEqual([]);
    expect(s.list({ view: "all" }).loops.map((l) => l.id)).toEqual([b.id, a.id]);
  });

  it("a loop past its review date is stale", () => {
    const s = store();
    const loop = loopIn(s);
    expect(s.list({ view: "stale" }).loops).toEqual([]);
    clock += 8 * DAY;
    expect(s.list({ view: "stale" }).loops.map((l) => l.id)).toEqual([loop.id]);
  });
});

describe("wakes", () => {
  it("claimDue claims a due loop once; settling reopens it with the wake spent", () => {
    const s = store();
    const loop = loopIn(s, dm, { revisit: { dueAt: T0 + 60_000 } });
    expect(s.claimDue(T0, 30_000)).toEqual([]);
    clock = T0 + 60_000;
    const [claimed, ...more] = s.claimDue(clock, 30_000);
    expect(more).toEqual([]);
    expect(claimed).toMatchObject({ id: loop.id, address: dm, principal });
    expect(s.claimDue(clock, 30_000)).toEqual([]);
    expect(s.update(loop.id, { next: "x" }, operator)).toMatchObject({ ok: false });
    expect(s.closeLoop(loop.id, "done", "x", operator)).toMatchObject({ ok: false });
    expect(s.settleWake(loop.id, "not-the-token", "schedule")).toBe(false);
    expect(s.settleWake(loop.id, claimed?.leaseToken as string, "schedule")).toBe(true);
    const after = s.list({ view: "all" }).loops[0];
    expect(after).toMatchObject({ status: "open", wake: null, dueAt: null, firedBy: "schedule" });
    clock += DAY;
    expect(s.claimDue(clock, 30_000)).toEqual([]);
  });

  it("a failing wake is retried after its lease, then given up as undeliverable, and the loop stays usable", () => {
    const s = store();
    const loop = loopIn(s, dm, { revisit: { dueAt: T0 } });
    for (let attempt = 1; attempt <= 5; attempt++) {
      clock += 60_000;
      const [claimed] = s.claimDue(clock, 30_000);
      expect(s.failWake(loop.id, claimed?.leaseToken as string, { reason: "queue busy" })).toBe(
        true,
      );
      // Open, so the agent can change it, but not claimable again until the lease runs out.
      expect(s.loop(loop.id)?.status).toBe("open");
      if (attempt < 5) expect(s.claimDue(clock + 1, 30_000)).toEqual([]);
    }
    clock += 60_000;
    expect(s.claimDue(clock, 30_000)).toEqual([]);
    expect(s.loop(loop.id)).toMatchObject({
      status: "open",
      wake: "undeliverable",
      wakeAttempts: 5,
      wakeError: "queue busy",
    });
    expect(s.update(loop.id, { next: "ask again" }, operator).ok).toBe(true);
    const other = loopIn(s, dm, { revisit: { dueAt: clock } });
    const [claimed] = s.claimDue(clock, 30_000);
    s.failWake(other.id, claimed?.leaseToken as string, { reason: "no address", final: true });
    expect(s.loop(other.id)?.wake).toBe("undeliverable");
  });

  it("a claim that never settles counts, so a crashing delivery is given up, not claimed forever", () => {
    const s = store({ maxWakeAttempts: 3 });
    const loop = loopIn(s, dm, { revisit: { dueAt: T0 } });
    for (let i = 0; i < 3; i++) {
      clock += 60_000;
      expect(s.claimDue(clock, 30_000).map((c) => c.id)).toEqual([loop.id]);
    }
    clock += 60_000;
    expect(s.claimDue(clock, 30_000)).toEqual([]);
    expect(s.loop(loop.id)).toMatchObject({ status: "open", wake: "undeliverable" });
  });

  it("one tick claims at most its limit, oldest due first", () => {
    const s = store({ claimLimit: 3 });
    const ids = Array.from(
      { length: 5 },
      (_, i) => loopIn(s, dm, { revisit: { dueAt: T0 + (5 - i) * 1_000 } }).id,
    );
    clock = T0 + 10_000;
    expect(s.claimDue(clock, 60_000).map((c) => c.id)).toEqual([ids[4], ids[3], ids[2]]);
    expect(s.claimDue(clock, 60_000).map((c) => c.id)).toEqual([ids[1], ids[0]]);
  });

  it("a loop opened just after its event fired is due at once; long after, it waits for the next", () => {
    const s = store();
    s.eventOccurred("build-finished:web", T0, "run 7", T0);
    clock = T0 + 5 * 60_000;
    const soon = loopIn(s, dm, { revisit: { onEvent: "build-finished:web" } });
    expect(soon).toMatchObject({ dueAt: clock, firedBy: "run 7" });
    clock = T0 + 11 * 60_000;
    const late = loopIn(s, dm, { revisit: { onEvent: "build-finished:web" } });
    expect(late.dueAt).toBeNull();
  });

  it("a loop waiting on a retry isn't woken by the run it retries, only by a later one, and its wake says which", () => {
    const s = store();
    s.eventOccurred("build-finished:web", T0, "run 7", T0);
    clock = T0 + 2 * 60_000;
    // Without onlyNew, run 7 would make it due at once (the case above).
    const retry = loopIn(s, dm, { revisit: { onEvent: "build-finished:web", onlyNew: true } });
    expect(retry).toMatchObject({ dueAt: null, firedBy: null });
    // Run 7's completion recorded late, after the loop was armed, still doesn't wake it.
    clock = T0 + 3 * 60_000;
    expect(s.eventOccurred("build-finished:web", T0, "run 7", clock)).toBe(0);
    clock = T0 + 10 * 60_000;
    expect(s.eventOccurred("build-finished:web", clock, "run 8", clock)).toBe(1);
    expect(s.loop(retry.id)).toMatchObject({ dueAt: clock, firedBy: "run 8" });
    expect(wakeOf(s, retry.id)).toContain("; fired by run 8): ");
  });

  it("an event with a time that isn't a number is ignored", () => {
    const s = store();
    loopIn(s, dm, { revisit: { onEvent: "build-finished:web" } });
    expect(s.eventOccurred("build-finished:web", Number.NaN, "bad", T0)).toBe(0);
  });

  it("an event dated in the future counts as now, so it can't pin later loops as already fired", () => {
    const s = store();
    s.eventOccurred("build-finished:web", T0 + 365 * DAY, "bad clock", T0);
    clock = T0 + 20 * 60_000;
    expect(loopIn(s, dm, { revisit: { onEvent: "build-finished:web" } }).dueAt).toBeNull();
  });

  it("an undeliverable wake is recorded but never claimed", () => {
    const s = store();
    const loop = loopIn(s, dm, { revisit: { dueAt: T0 }, deliverable: false });
    expect(loop.wake).toBe("undeliverable");
    expect(s.claimDue(T0 + DAY, 30_000)).toEqual([]);
  });

  it("an old event redelivered wakes loops armed before it, not ones armed since", () => {
    const s = store();
    const early = loopIn(s, dm, { revisit: { onEvent: "build-finished:web" } });
    clock = T0 + 30 * 60_000;
    const late = loopIn(s, thread, { revisit: { onEvent: "build-finished:web" } });
    expect(s.eventOccurred("build-finished:web", T0 + 5_000, "run 41", clock)).toBe(1);
    const claimed = s.claimDue(clock, 30_000);
    expect(claimed.map((c) => c.id)).toEqual([early.id]);
    expect(claimed[0]?.firedBy).toBe("run 41");
    expect(s.loop(late.id)?.dueAt).toBeNull();
  });

  it("a loop opened after its event happened but before it was recorded is still woken", () => {
    const s = store();
    clock = T0 + 1_000;
    const loop = loopIn(s, dm, { revisit: { onEvent: "build-finished:web" } });
    clock = T0 + 3_000;
    expect(s.eventOccurred("build-finished:web", T0, "run 8", clock)).toBe(1);
    expect(s.loop(loop.id)?.dueAt).toBe(clock);
  });

  it("re-arming on the event that just woke a loop waits for the next one, with a new wake key", () => {
    const s = store();
    const loop = loopIn(s, dm, { revisit: { onEvent: "build-finished:web" } });
    clock += 1_000;
    s.eventOccurred("build-finished:web", clock, "run 1", clock);
    const [first] = s.claimDue(clock, 30_000);
    s.settleWake(loop.id, first?.leaseToken as string, "run 1");
    clock += 1_000;
    s.update(loop.id, { revisit: { onEvent: "build-finished:web" } }, operator);
    expect(s.loop(loop.id)?.dueAt).toBeNull();
    expect(s.eventOccurred("build-finished:web", clock - 1_500, "run 1", clock)).toBe(0);
    clock += 60_000;
    expect(s.eventOccurred("build-finished:web", clock, "run 2", clock)).toBe(1);
    const [second] = s.claimDue(clock, 30_000);
    expect(second?.firedBy).toBe("run 2");
    expect(second?.wakeSeq).toBeGreaterThan(first?.wakeSeq as number);
  });

  it("due loops come before stale ones, however recently the stale ones changed", () => {
    const s = store();
    const due = loopIn(s, dm, { revisit: { dueAt: T0 + 60_000 } });
    for (let i = 0; i < 12; i++) {
      clock += 1;
      loopIn(s, thread, { reviewBy: T0 + 1 });
    }
    clock = T0 + 2 * 60_000;
    expect(s.list({ view: "all", limit: 5 }).loops[0]?.id).toBe(due.id);
  });
});

describe("orders", () => {
  it("one active order per subject: a second replaces the first, with history", () => {
    const s = store();
    const first = s.setOrder(
      { subject: "releases:web", rule: "hold", link: "https://x.test/1" },
      operator,
    );
    const second = s.setOrder(
      { subject: "releases:web", rule: "hold until the fix lands", link: "https://x.test/2" },
      operator,
    );
    expect(second.ok && second.replaced?.id).toBe(first.ok && first.order.id);
    expect(s.list({ view: "orders" }).orders.map((o) => o.rule)).toEqual([
      "hold until the fix lands",
    ]);
    expect(s.list({ view: "lifted" }).orders.map((o) => o.status)).toEqual(["replaced"]);
  });

  it("lift refuses a subject with no active order, and a lifted order stays visible for its window", () => {
    const s = store();
    expect(s.liftOrder("releases:api", "done", operator)).toMatchObject({ ok: false });
    s.setOrder({ subject: "releases:api", rule: "hold", link: "https://x.test/1" }, operator);
    const lifted = s.liftOrder("releases:api", "fixed", scheduled);
    expect(lifted).toMatchObject({ ok: true, order: { status: "lifted", endedBy: scheduled } });
    clock += 6 * DAY;
    expect(s.list({ view: "lifted" }).orders).toHaveLength(1);
    clock += 2 * DAY;
    expect(s.list({ view: "lifted" }).orders).toHaveLength(0);
  });

  it("an order lifted or replaced by anyone but its setter logs one order-change line with both origins", () => {
    const s = store();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const before = orderChangeCount();
    s.setOrder({ subject: "releases:web", rule: "hold", link: "https://x.test/1" }, operator);
    s.setOrder({ subject: "releases:web", rule: "go", link: "https://x.test/2" }, scheduled);
    expect(warn).toHaveBeenLastCalledWith(
      `[working] order-change subject="releases:web" set_by=operator(U-alice) by=scheduled(eve:app) count=${before + 1}`,
    );
    // A colleague's order lifted by someone else is a change too; a setter lifting their own isn't.
    s.setOrder({ subject: "releases:api", rule: "hold", link: "https://x.test/3" }, bob);
    s.liftOrder("releases:api", "done", operator);
    s.setOrder({ subject: "releases:docs", rule: "hold", link: "https://x.test/4" }, operator);
    s.liftOrder("releases:docs", "mine", operator);
    expect(orderChangeCount()).toBe(before + 2);
  });

  it("subjects match however they're written, and a lookalike can't make a second one", () => {
    const s = store();
    s.setOrder({ subject: "releases:web", rule: "hold", link: "https://x.test/1" }, operator);
    s.setOrder({ subject: "  Releases:WEB ", rule: "go", link: "https://x.test/2" }, operator);
    // Full-width letters and a zero-width space fold to the same subject; a Cyrillic о is refused.
    s.setOrder(
      { subject: "ｒｅｌｅａｓｅｓ:web​", rule: "go again", link: "https://x.test/3" },
      operator,
    );
    const cyrillic = s.setOrder(
      { subject: "releases:wоb", rule: "x", link: "https://x.test/4" },
      operator,
    );
    expect(cyrillic.ok).toBe(false);
    expect(s.list({ view: "orders" }).orders.map((o) => [o.subject, o.rule])).toEqual([
      ["releases:web", "go again"],
    ]);
    expect(s.liftOrder("RELEASES:web", "done", operator).ok).toBe(true);
  });

  it("orders the operator set come first, so a cap never hides them behind newer ones", () => {
    const s = store();
    s.setOrder({ subject: "releases:held", rule: "hold", link: "https://x.test/0" }, operator);
    for (let i = 0; i < 45; i++) {
      clock += 1;
      s.setOrder({ subject: `releases:c${i}`, rule: "x", link: "https://x.test/1" }, bob);
    }
    expect(s.list({ view: "orders", limit: 30 }).orders[0]?.subject).toBe("releases:held");
  });
});

describe("bounds", () => {
  it("refuses past each cap, naming the way out, and keeps an entry's first and latest events", () => {
    const s = store({ limits: { loops: 2, orders: 1, notes: 1 }, eventsPerEntry: 3 });
    const a = loopIn(s);
    loopIn(s);
    const third = s.open(
      { address: dm, principal: null, what: "w", waitingOn: "me", next: "n" },
      operator,
    );
    expect(!third.ok && third.reason).toMatch(/2 open loops.*\(close\)/);
    s.setOrder({ subject: "releases:web", rule: "hold", link: "https://x.test/1" }, operator);
    const order = s.setOrder(
      { subject: "releases:api", rule: "hold", link: "https://x.test/2" },
      operator,
    );
    expect(!order.ok && order.reason).toMatch(/\(lift\)/);
    s.addNote({ text: "one" }, operator);
    expect(s.addNote({ text: "two" }, operator).ok).toBe(false);
    for (let i = 0; i < 5; i++) s.update(a.id, { next: `step ${i}` }, operator);
    const kept = s.history(a.id);
    expect(kept.map((e) => e.change)).toEqual(["opened", "updated", "updated"]);
    expect(kept.at(-1)?.after?.next).toBe("step 4");
  });

  it("closed entries and their history are pruned after the retention window", () => {
    const s = store({ retentionDays: 30 });
    const loop = loopIn(s);
    s.closeLoop(loop.id, "done", "ok", operator);
    const open = loopIn(s);
    clock += 31 * 86_400_000;
    loopIn(s);
    expect(s.loop(loop.id)).toBeUndefined();
    expect(s.history(loop.id)).toEqual([]);
    expect(s.loop(open.id)?.status).toBe("open");
  });
});

describe("notes", () => {
  it("expire on their own", () => {
    const s = store();
    s.addNote({ text: "the web build is mid-migration" }, operator);
    expect(s.list({ view: "notes" }).notes).toHaveLength(1);
    clock += 7 * DAY;
    expect(s.list({ view: "notes" }).notes).toHaveLength(0);
  });
});

describe("revertBatch", () => {
  it("never brings back a reminder already sent", () => {
    const s = store();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const loop = loopIn(s, dm, { revisit: { dueAt: T0 } });
    s.update(loop.id, { next: "edited by Bob" }, bob);
    const [claimed] = s.claimDue(T0, 30_000);
    s.settleWake(loop.id, claimed?.leaseToken as string, "schedule");
    expect(s.revertBatch({ sessionId: bob.sessionId as string }, operator)).toBe(1);
    expect(s.loop(loop.id)).toMatchObject({ next: "publish the release", wake: null });
    clock += 60_000;
    expect(s.claimDue(clock, 30_000)).toEqual([]);
  });

  it("undoes one session's changes and leaves the rest", () => {
    const s = store();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const kept = loopIn(s);
    s.setOrder({ subject: "releases:web", rule: "hold", link: "https://x.test/1" }, operator);
    const bad: Origin = { principalId: "U-bob", kind: "other", sessionId: "bad" };
    s.closeLoop(kept.id, "dropped", "bob closed it", bad);
    s.liftOrder("releases:web", "bob lifted it", bad);
    const created = s.open(
      { address: thread, principal: null, what: "x", waitingOn: "me", next: "y" },
      bad,
    );
    expect(s.revertBatch({}, operator)).toBe(0);
    expect(s.revertBatch({ sessionId: "bad" }, operator)).toBe(3);
    const all = s.list({ view: "all" });
    expect(all.loops.map((l) => l.id)).toEqual([kept.id]);
    expect(all.orders.map((o) => o.rule)).toEqual(["hold"]);
    expect(created.ok && s.history(created.loop.id).at(-1)?.change).toBe("reverted");
  });
});

describe("schema", () => {
  it("a released migration step never changes: a change to the schema is a new step", () => {
    expect(
      createHash("sha256")
        .update(MIGRATIONS[0] as string)
        .digest("hex"),
    ).toBe("5b96bb3abd84dff3b5d7803a23c7083cc673b1961c13f6b1e14a0b9a800ba1ae");
  });
});

describe("links", () => {
  it("a host's own schemes replace the defaults; none means URLs only, and a bare colon never passes", () => {
    const custom = linkRule(["jira"]);
    expect(custom.test("jira:OPS-4")).toBe(true);
    expect(custom.test("linear:ABC-1")).toBe(false);
    const none = linkRule([]);
    expect(none.test("https://example.test/a")).toBe(true);
    expect(none.test(":x")).toBe(false);
    expect(none.rule).toBe("an http(s) URL; no spaces, <, > or |");
  });
});
