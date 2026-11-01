import { afterEach, describe, expect, it, vi } from "vitest";

import type { Address } from "./addresses.js";
import { addressKey } from "./addresses.js";
import { type Origin, orderChangeCount, parseOn, parseWhen, WorkingStore } from "./store.js";

const DAY = 86_400_000;
const T0 = Date.parse("2026-11-01T16:00:00Z");
const dm: Address = { kind: "slack-dm", teamId: "T1", channelId: "D1" };
const thread: Address = { kind: "slack-thread", teamId: "T1", channelId: "C1", threadTs: "1.1" };
const operator: Origin = {
  principalId: "U-alice",
  kind: "operator",
  sessionId: "s1",
  callId: "c1",
};
const scheduled: Origin = { principalId: "eve:app", kind: "scheduled", sessionId: "s2" };
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
const loopIn = (s: WorkingStore, address: Address = dm, extra = {}) => {
  const r = s.open(
    {
      address,
      principal,
      what: "zero digest approval",
      waitingOn: "lexi",
      next: "deploy zero",
      ...extra,
    },
    operator,
  );
  if (!r.ok) throw new Error(r.reason);
  return r.loop;
};

describe("the follow-ups grammar", () => {
  it("reads relative and ISO times and refuses the past", () => {
    expect(parseWhen("in 2 hours", T0)).toEqual({ at: T0 + 2 * 3_600_000 });
    expect(parseWhen("2026-11-02T09:00:00-07:00", T0)).toEqual({
      at: Date.parse("2026-11-02T16:00:00Z"),
    });
    expect(parseWhen("in 0 days", T0)).toHaveProperty("refused");
    expect(parseWhen("2026-10-01T00:00:00Z", T0)).toHaveProperty("refused");
    expect(parseWhen("tomorrow", T0)).toHaveProperty("refused");
  });
  it("names deploy events for the fleet it's given, and refuses without one", () => {
    expect(parseOn("deploy-completed:Ollie", ["zero", "ollie"])).toEqual({
      event: "deploy-completed:ollie",
    });
    expect(parseOn("deploy-completed:bob", ["zero"])).toHaveProperty("refused");
    expect(parseOn("merged:pr", ["zero"])).toHaveProperty("refused");
    expect(parseOn("deploy-completed:zero", [])).toHaveProperty("refused");
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
    expect(loop.followupNote).toContain(loop.id);
    expect(s.history(loop.id).map((e) => e.change)).toEqual(["opened"]);
  });

  it("closing is an event, never a deletion, and a second close returns the first", () => {
    const s = store();
    const loop = loopIn(s, dm, { revisit: { dueAt: T0 + 60_000 } });
    const closed = s.closeLoop(loop.id, "done", "deployed", operator);
    expect(closed).toMatchObject({
      ok: true,
      loop: { status: "done", why: "deployed", wake: null },
    });
    const again = s.closeLoop(loop.id, "dropped", "x", operator);
    expect(again.ok).toBe(false);
    expect(!again.ok && again.reason).toMatch(/already closed as done.*deployed/);
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

  it("update changes next and links and rewrites the wake note", () => {
    const s = store();
    const loop = loopIn(s);
    const r = s.update(loop.id, { next: "ask Ollie", links: ["https://example.test/1"] }, operator);
    expect(r.ok && r.loop.followupNote).toContain("ask Ollie");
    expect(r.ok && r.loop.followupNote).toContain("https://example.test/1");
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

  it("a released wake stays due; an expired lease is claimed again", () => {
    const s = store();
    const loop = loopIn(s, dm, { revisit: { dueAt: T0 } });
    const [first] = s.claimDue(T0, 30_000);
    expect(s.releaseWake(loop.id, first?.leaseToken as string)).toBe(true);
    const [second] = s.claimDue(T0, 30_000);
    expect(second?.id).toBe(loop.id);
    expect(s.claimDue(T0 + 29_999, 30_000)).toEqual([]);
    const [third] = s.claimDue(T0 + 30_000, 30_000);
    expect(third?.id).toBe(loop.id);
    expect(s.settleWake(loop.id, second?.leaseToken as string, "x")).toBe(false);
  });

  it("an undeliverable wake is recorded but never claimed", () => {
    const s = store();
    const loop = loopIn(s, dm, { revisit: { dueAt: T0 }, deliverable: false });
    expect(loop.wake).toBe("undeliverable");
    expect(s.claimDue(T0 + DAY, 30_000)).toEqual([]);
  });

  it("an event wakes loops whose wake was set by then, and not one set after", () => {
    const s = store();
    const early = loopIn(s, dm, { revisit: { onEvent: "deploy-completed:zero" } });
    clock = T0 + 10_000;
    const late = loopIn(s, thread, { revisit: { onEvent: "deploy-completed:zero" } });
    expect(s.eventOccurred("deploy-completed:zero", T0 + 5_000, "run 41", clock)).toBe(1);
    const claimed = s.claimDue(clock, 30_000);
    expect(claimed.map((c) => c.id)).toEqual([early.id]);
    expect(claimed[0]?.firedBy).toBe("run 41");
    expect(s.list({ view: "all" }).loops.find((l) => l.id === late.id)?.dueAt).toBeNull();
  });

  it("a revisit added later to an old loop isn't woken by an earlier event", () => {
    const s = store();
    const loop = loopIn(s);
    clock = T0 + 10_000;
    s.update(loop.id, { revisit: { onEvent: "deploy-completed:zero" } }, operator);
    expect(s.eventOccurred("deploy-completed:zero", T0 + 5_000, "old run", clock)).toBe(0);
  });
});

describe("orders", () => {
  it("one active order per subject: a second replaces the first, with history", () => {
    const s = store();
    const first = s.setOrder(
      { subject: "deploys:ollie", rule: "hold", link: "https://x.test/1" },
      operator,
    );
    const second = s.setOrder(
      { subject: "deploys:ollie", rule: "hold until Friday", link: "https://x.test/2" },
      operator,
    );
    expect(second.ok && second.replaced?.id).toBe(first.ok && first.order.id);
    expect(s.list({ view: "orders" }).orders.map((o) => o.rule)).toEqual(["hold until Friday"]);
    expect(s.list({ view: "lifted" }).orders.map((o) => o.status)).toEqual(["replaced"]);
  });

  it("lift refuses a subject with no active order, and a lifted order stays visible for its window", () => {
    const s = store();
    expect(s.liftOrder("deploys:felix", "done", operator)).toMatchObject({ ok: false });
    s.setOrder({ subject: "deploys:felix", rule: "hold", link: "https://x.test/1" }, operator);
    const lifted = s.liftOrder("deploys:felix", "fixed", scheduled);
    expect(lifted).toMatchObject({ ok: true, order: { status: "lifted", endedBy: scheduled } });
    clock += 6 * DAY;
    expect(s.list({ view: "lifted" }).orders).toHaveLength(1);
    clock += 2 * DAY;
    expect(s.list({ view: "lifted" }).orders).toHaveLength(0);
  });

  it("an operator's order lifted or replaced from another origin logs one order-change line and counts", () => {
    const s = store();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const before = orderChangeCount();
    s.setOrder({ subject: "deploys:ollie", rule: "hold", link: "https://x.test/1" }, operator);
    s.setOrder({ subject: "deploys:ollie", rule: "go", link: "https://x.test/2" }, scheduled);
    expect(orderChangeCount()).toBe(before + 1);
    expect(warn).toHaveBeenLastCalledWith(
      `[working] order-change subject="deploys:ollie" by=scheduled count=${before + 1}`,
    );
    s.setOrder({ subject: "deploys:zero", rule: "hold", link: "https://x.test/3" }, operator);
    s.liftOrder("deploys:zero", "operator lifted it", operator);
    s.setOrder({ subject: "deploys:felix", rule: "hold", link: "https://x.test/4" }, scheduled);
    s.liftOrder("deploys:felix", "fine", scheduled);
    expect(orderChangeCount()).toBe(before + 1);
    s.setOrder({ subject: "deploys:zero", rule: "hold", link: "https://x.test/5" }, operator);
    s.liftOrder("deploys:zero", "colleague", { ...scheduled, kind: "colleague" });
    expect(orderChangeCount()).toBe(before + 2);
  });
});

describe("notes", () => {
  it("expire on their own", () => {
    const s = store();
    s.addNote({ text: "Ollie is mid-migration" }, operator);
    expect(s.list({ view: "notes" }).notes).toHaveLength(1);
    clock += 7 * DAY;
    expect(s.list({ view: "notes" }).notes).toHaveLength(0);
  });
});

describe("revertBatch", () => {
  it("undoes one session's changes and leaves the rest", () => {
    const s = store();
    const kept = loopIn(s);
    s.setOrder({ subject: "deploys:ollie", rule: "hold", link: "https://x.test/1" }, operator);
    const bad: Origin = { principalId: "U-bob", kind: "other", sessionId: "bad" };
    s.closeLoop(kept.id, "dropped", "bob closed it", bad);
    s.liftOrder("deploys:ollie", "bob lifted it", bad);
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
