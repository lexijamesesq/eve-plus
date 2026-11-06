import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defineMemory } from "eve/memory";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import type { Address } from "./addresses.js";
import {
  HERE_ID,
  STANDING_ID,
  type WorkingMemoryOptions,
  workingMemory,
  workingToolSpecs,
} from "./provider.js";
import { type Loop, WorkingStore, wakeAuthorityOf, workingStorePath } from "./store.js";

// eve hands the provider full runtime contexts; these tests drive it with only the fields it reads. provider.ts is
// checked against eve's own contract when it compiles, so this seam is narrowed to what the tests call.
type Input = Record<string, unknown>;
interface Tool {
  execute(input: Input, context: Input): Promise<string>;
}
type Name = keyof typeof workingToolSpecs;
interface Harness {
  tools(context: { memory: Input }): Promise<Record<Name, Tool>>;
  recall: {
    "turn.started"(
      context: Input,
    ): Promise<{ messages: { content: string; id?: string }[] } | null>;
  };
}

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "working-provider-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
afterEach(() => vi.restoreAllMocks());

// Slack principals as the host sees them: Alice (the operator) in a DM thread or a channel thread, and Bob.
const slack = (principalId: string, channel: string, thread: string) => ({
  principalId,
  principalType: "user",
  authenticator: "slack-webhook",
  attributes: { channel_id: channel, thread_ts: thread, team_id: "T1" },
});
const ALICE_DM_1 = slack("U-alice", "D1", "100.1");
const ALICE_DM_2 = slack("U-alice", "D1", "200.2");
const ALICE_THREAD = slack("U-alice", "C1", "300.3");
const BOB_THREAD = slack("U-bob", "C1", "400.4");
const LINEAR = {
  principalId: "linear-u",
  principalType: "user",
  authenticator: "linear-webhook",
  attributes: { organization_id: "org", agent_session_id: "as1", issue_id: "iss" },
};
const SCHEDULE = {
  principalId: "eve:app",
  principalType: "app",
  authenticator: "schedule",
  attributes: {},
};

// The host's resolver: a DM is its channel, a channel message its thread, a Linear session itself, a schedule none.
const conversation = (auth: Input | null): Address | null => {
  const a = (auth?.attributes ?? {}) as Record<string, string>;
  if (auth?.authenticator === "slack-webhook")
    return a.channel_id?.startsWith("D")
      ? { kind: "slack-dm", teamId: a.team_id as string, channelId: a.channel_id }
      : {
          kind: "slack-thread",
          teamId: a.team_id as string,
          channelId: a.channel_id as string,
          threadTs: a.thread_ts as string,
        };
  if (auth?.authenticator === "linear-webhook")
    return {
      kind: "linear-session",
      organizationId: a.organization_id as string,
      agentSessionId: a.agent_session_id as string,
      issueId: a.issue_id as string,
    };
  return null;
};
const originKind = (auth: Input | null, session: { schedule?: unknown }) =>
  session.schedule !== undefined
    ? "scheduled"
    : auth?.principalId === "U-alice"
      ? "operator"
      : "colleague";

let calls = 0;
const turn = (auth: Input | null, extra: Input = {}) => ({
  session: {
    id: `sess-${String(auth?.principalId)}`,
    turn: { id: `turn-${calls}`, sequence: 1 },
    auth: { current: auth, initiator: auth },
    ...extra,
  },
  callId: `call-${calls++}`,
  abortSignal: new AbortController().signal,
});
const memory = {
  scope: { key: "agent:assistant", namespace: "assistant-working-v1", value: "agent:assistant" },
  slot: "working",
};

let clock = Date.parse("2026-11-01T16:00:00Z");
async function agent(options: Partial<WorkingMemoryOptions> & { dir?: string } = {}) {
  const dir = options.dir ?? tempDir();
  const provider = workingMemory({
    dir,
    conversation: conversation as WorkingMemoryOptions["conversation"],
    originKind: originKind as WorkingMemoryOptions["originKind"],
    deliverable: (a) => a.kind.startsWith("slack"),
    events: ["build-finished:web", "build-finished:api"],
    now: () => clock,
    ...options,
  }) as unknown as Harness;
  const raw = await provider.tools({ memory });
  // eve validates input against each tool's schema before execute; so does this harness.
  const call = (name: Name, input: Input, auth: Input | null, extra: Input = {}) =>
    raw[name].execute(workingToolSpecs[name].inputSchema.parse(input) as Input, turn(auth, extra));
  const recall = async (auth: Input | null, extra: Input = {}) => {
    const r = await provider.recall["turn.started"]({ ...turn(auth, extra), messages: [], memory });
    return r?.messages ?? [];
  };
  return { dir, provider, call, recall };
}
const text = (messages: { content: string; id?: string }[], id: string) =>
  messages.find((m) => m.id === id)?.content ?? "";

describe("the provider through eve's memory contract", () => {
  it("defineMemory accepts it", async () => {
    const { provider } = await agent();
    expect(() =>
      defineMemory({
        provider: provider as never,
        scope: () => "agent:assistant",
        namespace: "assistant-working-v1",
      }),
    ).not.toThrow();
  });

  it("recall returns exactly the two stable ids, every turn, even with nothing stored", async () => {
    const a = await agent();
    for (const auth of [ALICE_DM_1, null]) {
      const messages = await a.recall(auth);
      expect(messages.map((m) => m.id)).toEqual([HERE_ID, STANDING_ID]);
      for (const m of messages) expect(m.content.length).toBeGreaterThan(0);
    }
  });

  it("a new top-level DM sees a loop an earlier DM thread opened", async () => {
    const a = await agent();
    const opened = await a.call(
      "open",
      { what: "release notes approval", waitingOn: "alice", next: "publish the release" },
      ALICE_DM_1,
    );
    const id = /Opened loop (L[0-9a-f]+)/.exec(opened)?.[1];
    expect(id).toBeDefined();
    const here = text(await a.recall(ALICE_DM_2), HERE_ID);
    expect(here).toContain(`${id} waiting on alice: release notes approval`);
    const elsewhere = text(await a.recall(ALICE_THREAD), STANDING_ID);
    expect(elsewhere).toContain(`${id} (Slack DM D1)`);
  });

  it("a schedule turn has no here, sees every loop in standing, and can't open one", async () => {
    const a = await agent();
    await a.call("open", { what: "w", waitingOn: "me", next: "n" }, ALICE_DM_1);
    const messages = await a.recall(SCHEDULE, { schedule: { name: "look" } });
    expect(text(messages, HERE_ID)).toContain("No conversation address for this turn");
    expect(text(messages, STANDING_ID)).toContain("Open elsewhere (1):");
    expect(
      await a.call("open", { what: "w", waitingOn: "me", next: "n" }, SCHEDULE, { schedule: {} }),
    ).toMatch(/open it from the conversation it belongs to/i);
  });

  it("a closed loop is absent from the next turn's blocks", async () => {
    const a = await agent();
    const id = /(L[0-9a-f]+)/.exec(
      await a.call("open", { what: "w", waitingOn: "me", next: "n" }, ALICE_DM_1),
    )?.[1];
    expect(await a.call("close", { id, outcome: "done", why: "published" }, ALICE_DM_1)).toContain(
      "Closed",
    );
    const messages = await a.recall(ALICE_DM_1);
    expect(messages.map((m) => m.content).join("\n")).not.toContain(id as string);
    expect(text(messages, HERE_ID)).toContain("Nothing open in this conversation.");
  });

  it("identity and address come from the session, never from arguments", async () => {
    const a = await agent();
    expect(() =>
      workingToolSpecs.open.inputSchema.parse({
        what: "w",
        waitingOn: "me",
        next: "n",
        address: { kind: "named", name: "x" },
      }),
    ).toThrow();
    await a.call("open", { what: "w", waitingOn: "me", next: "n" }, BOB_THREAD);
    const store = new WorkingStore(workingStorePath(a.dir));
    const [loop] = store.list({ view: "all" }).loops;
    expect(loop).toMatchObject({
      address: { kind: "slack-thread", channelId: "C1", threadTs: "400.4" },
      origin: { principalId: "U-bob", kind: "colleague" },
    });
    expect(loop?.origin.callId).toMatch(/^call-/);
    store.close();
  });

  it("a revisit where no wake can be delivered opens the loop and says it shows as due", async () => {
    const a = await agent();
    const reply = await a.call(
      "open",
      { what: "w", waitingOn: "me", next: "n", revisit: { when: "in 1 hour" } },
      LINEAR,
    );
    expect(reply).toMatch(/Opened loop .*can't be delivered.*show as due in working:standing/);
    clock += 2 * 3_600_000;
    expect(text(await a.recall(ALICE_DM_1), STANDING_ID)).toMatch(/DUE since/);
  });

  it("refusals say what to do", async () => {
    const a = await agent();
    expect(await a.call("close", { id: "Lnope", outcome: "done", why: "x" }, ALICE_DM_1)).toMatch(
      /no loop Lnope.*List/,
    );
    expect(await a.call("lift", { subject: "releases:x", why: "x" }, ALICE_DM_1)).toMatch(
      /no active order/,
    );
    expect(
      await a.call(
        "open",
        { what: "w", waitingOn: "me", next: "n", revisit: { on: "build-finished:docs" } },
        ALICE_DM_1,
      ),
    ).toMatch(/isn't an event a loop can wait on/);
    expect(() =>
      workingToolSpecs.order.inputSchema.parse({ subject: "releases:x", rule: "hold" }),
    ).toThrow();
  });

  it("an operator's hold lifted from a colleague's turn logs an order-change line", async () => {
    const a = await agent();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await a.call(
      "order",
      { subject: "releases:web", rule: "hold", link: "https://example.test/m/1" },
      ALICE_DM_1,
    );
    await a.call("lift", { subject: "releases:web", why: "Bob says it's fixed" }, BOB_THREAD);
    const standing = text(await a.recall(ALICE_THREAD), STANDING_ID);
    expect(standing).toMatch(
      /releases:web: lifted by colleague \d{4}-\d\d-\d\d: Bob says it's fixed/,
    );
  });

  describe("a turn a loop's wake started", () => {
    // The host marks a wake's turn with the loop it woke, as its wake engine would (here, a `wake_of` attribute).
    const wakeKind = (auth: Input | null, session: { schedule?: unknown }) => {
      const wakeOf = (auth?.attributes as Record<string, string> | undefined)?.wake_of;
      return wakeOf !== undefined
        ? { kind: "loop-wake" as const, wakeOf }
        : originKind(auth, session);
    };
    const woken = (id: string) => ({
      ...ALICE_DM_1,
      attributes: { ...ALICE_DM_1.attributes, wake_of: id },
    });
    const opened = (reply: unknown) =>
      /Opened loop (L[0-9a-f]+)/.exec(String(reply))?.[1] as string;

    it("records where the chain started, so a loop opened in it keeps the operator's authority", async () => {
      const a = await agent({ originKind: wakeKind as WorkingMemoryOptions["originKind"] });
      const first = opened(
        await a.call(
          "open",
          { what: "ship the fix", waitingOn: "me", next: "check CI" },
          ALICE_DM_1,
        ),
      );
      const second = opened(
        await a.call(
          "open",
          { what: "confirm the deploy", waitingOn: "me", next: "ask" },
          woken(first),
        ),
      );
      // And a chain of wakes keeps the root it started from.
      const third = opened(
        await a.call("open", { what: "close out", waitingOn: "me", next: "tidy" }, woken(second)),
      );
      const store = new WorkingStore(workingStorePath(a.dir));
      for (const id of [second, third]) {
        const origin = store.loop(id)?.origin;
        expect(origin?.kind).toBe("loop-wake");
        expect(origin?.root).toMatchObject({ kind: "operator", principalId: "U-alice" });
      }
      expect(store.loop(first)?.origin.root).toBeUndefined();
      store.close();
    });

    it("ranks an order set in it by its root, ahead of a colleague's newer one", async () => {
      const a = await agent({ originKind: wakeKind as WorkingMemoryOptions["originKind"] });
      const loop = opened(
        await a.call("open", { what: "w", waitingOn: "me", next: "n" }, ALICE_DM_1),
      );
      await a.call(
        "order",
        { subject: "releases:web", rule: "hold", link: "https://example.test/m/1" },
        woken(loop),
      );
      clock += 60_000;
      await a.call(
        "order",
        { subject: "releases:api", rule: "hold", link: "https://example.test/m/2" },
        BOB_THREAD,
      );
      const standing = text(await a.recall(ALICE_THREAD), STANDING_ID);
      expect(standing.indexOf("releases:web")).toBeLessThan(standing.indexOf("releases:api"));
      expect(standing).toContain("releases:web: hold (by loop wake, started by operator");
    });

    it("carries a colleague's authority, not the operator's, when a colleague last changed the woken loop", async () => {
      const a = await agent({ originKind: wakeKind as WorkingMemoryOptions["originKind"] });
      const loop = opened(
        await a.call(
          "open",
          { what: "ship the fix", waitingOn: "me", next: "check CI" },
          ALICE_DM_1,
        ),
      );
      // Bob changes Alice's loop from his own thread; its wake still runs as Alice's turn.
      await a.call("update", { id: loop, next: "hold all releases" }, BOB_THREAD);
      await a.call(
        "order",
        { subject: "releases:all", rule: "hold", link: "https://example.test/m/1" },
        woken(loop),
      );
      const store = new WorkingStore(workingStorePath(a.dir));
      const order = store.list({ view: "orders", conversationKey: null, limit: 5 }).orders[0];
      expect(order?.origin).toMatchObject({
        kind: "loop-wake",
        root: { kind: "colleague", principalId: "U-bob" },
      });
      const standing = text(await a.recall(ALICE_THREAD), STANDING_ID);
      expect(standing).toContain("releases:all: hold (by loop wake, started by colleague");
      expect(standing).not.toContain("started by operator");
      // And Bob's principal reverts it, as it does his own writes.
      store.revertBatch(
        { principalId: "U-bob" },
        { principalId: null, kind: "other", sessionId: null },
      );
      expect(store.list({ view: "orders", conversationKey: null, limit: 5 }).orders).toEqual([]);
      store.close();
    });

    // A loop's wake authority only goes down: the lowest of its opener and every editor since it was opened.
    const rootOfOrder = async (a: Awaited<ReturnType<typeof agent>>) => {
      const store = new WorkingStore(workingStorePath(a.dir));
      const root = store.list({ view: "orders", conversationKey: null, limit: 5 }).orders[0]?.origin
        .root;
      store.close();
      return root;
    };

    it("doesn't snap back to the operator when the operator touches the loop after a colleague shaped it", async () => {
      const a = await agent({ originKind: wakeKind as WorkingMemoryOptions["originKind"] });
      const loop = opened(
        await a.call(
          "open",
          { what: "ship the fix", waitingOn: "me", next: "check CI" },
          ALICE_DM_1,
        ),
      );
      await a.call("update", { id: loop, next: "hold all releases" }, BOB_THREAD);
      // Alice changes only whose move it is; Bob's next step still drives the wake.
      await a.call("update", { id: loop, waitingOn: "alice" }, ALICE_DM_1);
      await a.call(
        "order",
        { subject: "releases:all", rule: "hold", link: "https://example.test/m/1" },
        woken(loop),
      );
      expect(await rootOfOrder(a)).toMatchObject({ kind: "colleague", principalId: "U-bob" });
    });

    it("doesn't raise a colleague's loop to the operator when an operator's wake touches it", async () => {
      const a = await agent({ originKind: wakeKind as WorkingMemoryOptions["originKind"] });
      const mine = opened(
        await a.call("open", { what: "op loop", waitingOn: "me", next: "n" }, ALICE_DM_1),
      );
      const bobs = opened(
        await a.call("open", { what: "bob loop", waitingOn: "me", next: "n" }, BOB_THREAD),
      );
      // The operator's wake makes a trivial change to Bob's loop.
      await a.call("update", { id: bobs, next: "checked" }, woken(mine));
      await a.call(
        "order",
        { subject: "releases:web", rule: "hold", link: "https://example.test/m/1" },
        woken(bobs),
      );
      expect(await rootOfOrder(a)).toMatchObject({ kind: "colleague", principalId: "U-bob" });
    });

    it("lets a revert by kind reach a write a kind was the authority for through a wake", async () => {
      const a = await agent({ originKind: wakeKind as WorkingMemoryOptions["originKind"] });
      const bobs = opened(
        await a.call("open", { what: "bob loop", waitingOn: "me", next: "n" }, BOB_THREAD),
      );
      await a.call(
        "order",
        { subject: "releases:web", rule: "hold", link: "https://example.test/m/1" },
        woken(bobs),
      );
      const store = new WorkingStore(workingStorePath(a.dir));
      store.revertBatch(
        { kind: "colleague" },
        { principalId: null, kind: "other", sessionId: null },
      );
      expect(store.list({ view: "orders", conversationKey: null, limit: 5 }).orders).toEqual([]);
      store.close();
    });

    it("an onlyNew revisit set through the tools isn't woken by the occurrence just before it, and refuses a time", async () => {
      const a = await agent();
      const store = new WorkingStore(workingStorePath(a.dir));
      store.eventOccurred("build-finished:web", clock - 60_000, "run 7", clock);
      const revisit = { on: "build-finished:web", onlyNew: true };
      const retry = opened(
        await a.call("open", { what: "retry", waitingOn: "ci", next: "n", revisit }, ALICE_DM_1),
      );
      const plain = opened(
        await a.call(
          "open",
          { what: "plain", waitingOn: "ci", next: "n", revisit: { on: "build-finished:web" } },
          ALICE_DM_1,
        ),
      );
      expect(store.loop(retry)?.dueAt).toBeNull();
      expect(store.loop(plain)?.dueAt).not.toBeNull();
      const timed = await a.call(
        "open",
        {
          what: "timed",
          waitingOn: "ci",
          next: "n",
          revisit: { when: "2026-11-02T09:00", onlyNew: true },
        },
        ALICE_DM_1,
      );
      expect(JSON.stringify(timed)).toContain("`onlyNew` goes with `on`");
      store.close();
    });

    it("reads a loop a colleague edited before floors were kept as the colleague's, before and after the operator's edit", async () => {
      const a = await agent({ originKind: wakeKind as WorkingMemoryOptions["originKind"] });
      const loop = opened(
        await a.call(
          "open",
          { what: "ship the fix", waitingOn: "me", next: "check CI" },
          ALICE_DM_1,
        ),
      );
      await a.call("update", { id: loop, next: "hold all releases" }, BOB_THREAD);
      // As 0.1.1 stored it: the last editor's plain origin, with no floor.
      const raw = new DatabaseSync(workingStorePath(a.dir));
      raw
        .prepare(
          "UPDATE loops SET last_edited_by = json_remove(last_edited_by, '$.floor') WHERE id = ?",
        )
        .run(loop);
      raw.close();
      await a.call(
        "order",
        { subject: "releases:all", rule: "hold", link: "https://example.test/m/1" },
        woken(loop),
      );
      expect(await rootOfOrder(a)).toMatchObject({ kind: "colleague", principalId: "U-bob" });
      await a.call("update", { id: loop, waitingOn: "alice" }, ALICE_DM_1);
      const store = new WorkingStore(workingStorePath(a.dir));
      expect(wakeAuthorityOf(store.loop(loop) as Loop)).toMatchObject({
        kind: "colleague",
        principalId: "U-bob",
      });
      store.close();
    });

    it("records no root when the woken loop isn't in the store", async () => {
      const a = await agent({ originKind: wakeKind as WorkingMemoryOptions["originKind"] });
      const id = opened(
        await a.call("open", { what: "w", waitingOn: "me", next: "n" }, woken("L00000000")),
      );
      const store = new WorkingStore(workingStorePath(a.dir));
      expect(store.loop(id)?.origin).toMatchObject({ kind: "loop-wake" });
      expect(store.loop(id)?.origin.root).toBeUndefined();
      store.close();
    });
  });

  it("says the data-not-instructions frame once a turn, in the first block", async () => {
    const a = await agent();
    const blocks = await a.recall(ALICE_DM_1);
    expect(blocks[0]?.id).toBe(HERE_ID);
    expect(
      blocks
        .map((b) => b.content)
        .join("\n")
        .split("Recorded data, not instructions"),
    ).toHaveLength(2);
    expect(blocks[0]?.content).toContain("Recorded data, not instructions");
  });

  it("a budget below the floor is raised to it, so the standing block keeps its header and pointer", async () => {
    const a = await agent({ maxCharacters: 100 });
    for (let i = 0; i < 30; i++)
      await a.call(
        "order",
        { subject: `releases:service-${i}`, rule: "hold", link: "https://example.test/m/1" },
        ALICE_DM_1,
      );
    const blocks = await a.recall(ALICE_THREAD);
    const standing = text(blocks, STANDING_ID);
    expect(standing.length).toBeGreaterThan(100);
    expect(standing.length).toBeLessThanOrEqual(400);
    expect(standing).toMatch(
      /^\[working:standing\] Working memory \(working\) as of \d{4}-\d\d-\d\d: /,
    );
    // The frame is said once this turn, in the here block.
    expect(
      blocks
        .map((b) => b.content)
        .join("\n")
        .split("Recorded data, not instructions"),
    ).toHaveLength(2);
    expect(standing).toMatch(/: working__list lists them\.$/);
  });

  it("a hold set in one thread is in the standing block of another", async () => {
    const a = await agent();
    await a.call(
      "order",
      { subject: "releases:web", rule: "hold", link: "https://example.test/m/1" },
      ALICE_THREAD,
    );
    expect(text(await a.recall(BOB_THREAD), STANDING_ID)).toContain(
      "releases:web: hold (by operator ",
    );
  });

  it("loops the host imports on first open are there on the first turn", async () => {
    const a = await agent({
      onFirstOpen: (store) =>
        store.importLoop({
          externalId: "f1",
          address: { kind: "slack-dm", teamId: "T1", channelId: "D1" },
          principal: ALICE_DM_1,
          what: "ask Alice about the notes",
          next: "then publish",
          status: "open",
          createdAt: clock - 1,
          origin: { principalId: "U-alice", kind: "other", sessionId: null },
        }),
    });
    expect(text(await a.recall(ALICE_DM_2), HERE_ID)).toContain("ask Alice about the notes");
  });

  it("with 20 loops elsewhere, a due one updated longest ago is listed first", async () => {
    const a = await agent();
    await a.call(
      "open",
      { what: "the due one", waitingOn: "me", next: "n", revisit: { when: "in 1 minute" } },
      ALICE_THREAD,
    );
    for (let i = 0; i < 19; i++) {
      clock += 1_000;
      await a.call("open", { what: `fresh ${i}`, waitingOn: "me", next: "n" }, ALICE_THREAD);
    }
    clock += 120_000;
    const standing = text(await a.recall(ALICE_DM_1), STANDING_ID);
    const first = standing.split("\n").find((l) => l.startsWith("• L"));
    expect(first).toContain("the due one");
  });

  it("a store that can't be read makes a tool refuse, not throw", async () => {
    const dir = tempDir();
    writeFileSync(workingStorePath(dir), "not a database");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = await agent({ dir });
    expect(await a.call("note", { text: "x" }, ALICE_DM_1)).toBe(
      "Working memory is temporarily unavailable this turn; nothing was recorded. Act on what you can see, and say so if it matters.",
    );
  });

  it("a store it can read but not write still shows, marked read-only, and writes refuse", async () => {
    const dir = tempDir();
    const seed = await agent({ dir });
    await seed.call(
      "order",
      { subject: "releases:web", rule: "hold", link: "https://example.test/m/1" },
      ALICE_DM_1,
    );
    chmodSync(workingStorePath(dir), 0o444);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = await agent({ dir });
    const standing = text(await a.recall(ALICE_DM_1), STANDING_ID);
    expect(standing).toContain("read-only this turn");
    expect(standing).toContain("releases:web: hold");
    expect(await a.call("note", { text: "x" }, ALICE_DM_1)).toMatch(
      /^Working memory is temporarily unavailable/,
    );
  });

  it("list shows each view in full, says when there's nothing, and counts what it didn't show", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = await agent();
    expect(await a.call("list", { view: "all" }, ALICE_DM_1)).toContain("Nothing here.");
    const opened = await a.call(
      "open",
      { what: "check the notes", waitingOn: "alice", next: "publish" },
      ALICE_DM_1,
    );
    const id = /(L[0-9a-f]+)/.exec(opened)?.[1] as string;
    await a.call(
      "order",
      { subject: "releases:web", rule: "hold", link: "https://example.test/m/1" },
      ALICE_DM_1,
    );
    await a.call(
      "order",
      { subject: "releases:api", rule: "hold", link: "https://example.test/m/2" },
      ALICE_DM_1,
    );
    await a.call("lift", { subject: "releases:api", why: "fixed" }, BOB_THREAD);
    await a.call("note", { text: "the web build is mid-migration" }, ALICE_DM_1);
    const all = await a.call("list", { view: "all" }, ALICE_DM_1);
    expect(all).toContain(`${id} waiting on alice: check the notes`);
    expect(all).toContain("(opened in the operator's own conversation, principal U-alice)");
    expect(all).toContain(
      "releases:web: hold (set in the operator's own conversation (principal U-alice)",
    );
    expect(all).toMatch(/Lifted or replaced:\n• releases:api: lifted by colleague/);
    expect(all).toContain("• the web build is mid-migration");
    const here = await a.call("list", { view: "here" }, ALICE_DM_1);
    expect(here).toContain(id);
    expect(here).not.toContain("releases:");
    expect(await a.call("list", { view: "elsewhere" }, ALICE_DM_1)).toContain("Nothing here.");
    expect(await a.call("list", { view: "lifted" }, ALICE_DM_1)).toContain("releases:api: lifted");
  });

  it("update changes a loop, records an undeliverable revisit as such, and null removes it", async () => {
    const a = await agent();
    const id = /(L[0-9a-f]+)/.exec(
      await a.call("open", { what: "w", waitingOn: "me", next: "n" }, LINEAR),
    )?.[1] as string;
    expect(
      await a.call("update", { id, next: "n2", revisit: { when: "in 1 hour" } }, LINEAR),
    ).toMatch(
      /Updated loop .*wake can't be delivered there; it will show as due in working:standing/,
    );
    const store = new WorkingStore(workingStorePath(a.dir));
    expect(store.loop(id)).toMatchObject({ next: "n2", wake: "undeliverable" });
    expect(await a.call("update", { id, revisit: null }, LINEAR)).toBe(`Updated loop ${id}.`);
    expect(store.loop(id)).toMatchObject({ wake: null, dueAt: null });
    expect(await a.call("update", { id: "Lnope", next: "x" }, LINEAR)).toMatch(/no loop Lnope/);
    store.close();
  });

  it("the write cap refuses loudly past the limit", async () => {
    const a = await agent({ maxWritesPerSession: 1 });
    await a.call("note", { text: "one" }, ALICE_DM_1);
    await expect(a.call("note", { text: "two" }, ALICE_DM_1)).rejects.toThrow(/write limit/);
  });
});

describe("what the store keeps", () => {
  it("links are URLs or the reserved references, nothing that can spoof a label", () => {
    const parse = (link: string) =>
      workingToolSpecs.order.inputSchema.safeParse({ subject: "s", rule: "r", link }).success;
    for (const ok of [
      "https://example.test/a?b=1",
      "linear:ABC-12",
      "slack:C123/1.2",
      "working:L1a2b3c4d",
    ])
      expect(parse(ok)).toBe(true);
    for (const bad of [
      "<https://evil.example|https://slack.com>",
      "javascript:alert(1)",
      "data:text/html,hi",
      "see the thread",
    ])
      expect(parse(bad)).toBe(false);
  });

  it("keeps no personal details of the sender, and only its own user can read the store", async () => {
    // A directory that already exists, as a volume would, is tightened too when the agent owns it.
    const dir = join(tempDir(), "working");
    mkdirSync(dir, { mode: 0o755 });
    const a = await agent({ dir });
    const withEmail = {
      ...ALICE_DM_1,
      attributes: {
        ...ALICE_DM_1.attributes,
        email: "alice@example.test",
        full_name: "Alice Example",
      },
    };
    await a.call("open", { what: "w", waitingOn: "me", next: "n" }, withEmail);
    const raw = new DatabaseSync(workingStorePath(dir), { readOnly: true });
    const dump = JSON.stringify([
      raw.prepare("SELECT * FROM loops").all(),
      raw.prepare("SELECT * FROM events").all(),
    ]);
    raw.close();
    expect(dump).not.toContain("alice@example.test");
    expect(dump).not.toContain("Alice Example");
    expect(dump).toContain("D1");
    if (process.platform !== "win32") {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(workingStorePath(dir)).mode & 0o777).toBe(0o600);
    }
  });
});

describe("recall never throws", () => {
  const outage = (messages: { content: string; id?: string }[]) => {
    expect(messages.map((m) => m.id)).toEqual([HERE_ID, STANDING_ID]);
    for (const m of messages) expect(m.content).toContain("is temporarily unavailable this turn");
  };

  it("never throws on a corrupt store file, and says it's unavailable", async () => {
    const dir = tempDir();
    writeFileSync(workingStorePath(dir), "this is not a database, it's a note");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = await agent({ dir });
    outage(await a.recall(ALICE_DM_1));
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/^\[working\] turn-start recall failed: /),
    );
  });

  it("a directory that doesn't exist yet is made, not an outage", async () => {
    const a = await agent({ dir: join(tempDir(), "not", "yet") });
    expect(text(await a.recall(ALICE_DM_1), HERE_ID)).toContain(
      "Nothing open in this conversation.",
    );
  });

  it("a resolver that fails costs the turn its here block, never its holds", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = tempDir();
    const seed = await agent({ dir });
    await seed.call(
      "order",
      { subject: "releases:web", rule: "hold", link: "https://example.test/m/1" },
      ALICE_DM_1,
    );
    const a = await agent({
      dir,
      conversation: () => {
        throw new Error("resolver broke");
      },
    });
    const messages = await a.recall(ALICE_DM_1);
    expect(messages.map((m) => m.id)).toEqual([HERE_ID, STANDING_ID]);
    expect(text(messages, HERE_ID)).toContain("No conversation address for this turn");
    expect(text(messages, STANDING_ID)).toContain("releases:web: hold");
    expect(warn).toHaveBeenCalledWith("[working] conversation resolver failed: resolver broke");
  });

  it("recovers on the next turn once the store opens", async () => {
    const parent = tempDir();
    const blocker = join(parent, "working");
    writeFileSync(blocker, "");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = await agent({ dir: blocker });
    outage(await a.recall(ALICE_DM_1));
    rmSync(blocker);
    expect(text(await a.recall(ALICE_DM_1), HERE_ID)).toContain(
      "Nothing open in this conversation.",
    );
  });
});

describe("references", () => {
  const idOf = (reply: string) => /(L[0-9a-f]+)/.exec(reply)?.[1] as string;

  it("a working: link resolves from the store, closed loops included; a knowledge: link through the host", async () => {
    const seen: string[] = [];
    const a = await agent({
      resolve: async (link) => {
        seen.push(link);
        return link === "knowledge:acme"
          ? '"Acme" (Vendor, 5d)'
          : link === "knowledge:nobody"
            ? "(not found)"
            : null;
      },
    });
    const done = idOf(
      await a.call("open", { what: "the acme renewal", waitingOn: "acme", next: "n" }, ALICE_DM_2),
    );
    await a.call("close", { id: done, outcome: "done", why: "landed" }, ALICE_DM_2);
    clock += 3 * 86_400_000;
    await a.call(
      "open",
      {
        what: "write up the acme renewal",
        waitingOn: "me",
        next: "n",
        links: [`working:${done}`, "knowledge:acme", "knowledge:unseen", "vault:a.md"],
      },
      ALICE_DM_1,
    );
    await a.call(
      "open",
      { what: "ask nobody", waitingOn: "me", next: "n", links: ["knowledge:nobody"] },
      ALICE_DM_1,
    );
    const here = text(await a.recall(ALICE_DM_1), HERE_ID);
    expect(here).toContain(`working:${done} → "the acme renewal" (done, 3d)`);
    expect(here).toContain('knowledge:acme → "Acme" (Vendor, 5d)');
    expect(here).toContain("knowledge:nobody → (not found)");
    // Null from the host: the link stays as written, and so does one of a scheme nobody resolves.
    expect(here).toContain("knowledge:unseen vault:a.md");
    expect(here).not.toContain("knowledge:unseen →");
    expect([...seen].sort()).toEqual(["knowledge:acme", "knowledge:nobody", "knowledge:unseen"]);
  });

  it("a pruned or unknown loop is not found; without a host resolver other schemes stay as written", async () => {
    const a = await agent();
    await a.call(
      "open",
      { what: "w", waitingOn: "me", next: "n", links: ["working:Lffff", "knowledge:acme"] },
      ALICE_DM_1,
    );
    const here = text(await a.recall(ALICE_DM_1), HERE_ID);
    expect(here).toContain("working:Lffff → (not found)");
    expect(here).toContain("knowledge:acme");
    expect(here).not.toContain("knowledge:acme →");
  });

  it("a failing host resolver costs its links their targets, not the turn, and warns once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = await agent({
      resolve: async () => {
        throw new Error("graph closed");
      },
    });
    await a.call(
      "open",
      { what: "w", waitingOn: "me", next: "n", links: ["knowledge:a", "knowledge:b"] },
      ALICE_DM_1,
    );
    const messages = await a.recall(ALICE_DM_1);
    expect(text(messages, HERE_ID)).toContain("Links: knowledge:a knowledge:b");
    expect(text(messages, STANDING_ID)).toContain("Nothing else open.");
    expect(
      warn.mock.calls.filter((c) => String(c[0]).includes("reference resolver failed")),
    ).toHaveLength(1);
  });

  it("a resolver that never settles leaves its links as written, and recall still returns both blocks", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = await agent({ resolve: () => new Promise<string | null>(() => {}) });
    await a.call(
      "open",
      { what: "w", waitingOn: "me", next: "n", links: ["knowledge:a", "knowledge:b"] },
      ALICE_DM_1,
    );
    const messages = await a.recall(ALICE_DM_1);
    expect(text(messages, HERE_ID)).toContain("Links: knowledge:a knowledge:b");
    expect(text(messages, STANDING_ID)).toContain("Nothing else open.");
    const warned = warn.mock.calls.filter((c) =>
      String(c[0]).includes("reference resolver failed"),
    );
    expect(warned).toHaveLength(1);
    expect(String(warned[0]?.[0])).toContain("timed out");
  });

  it("looks up at most six distinct links per block, in order, and a link resolved for here is free in standing", async () => {
    const seen: string[] = [];
    const a = await agent({
      resolve: async (link) => {
        seen.push(link);
        return "(x)";
      },
    });
    const links = Array.from({ length: 8 }, (_, i) => `knowledge:k${i}`);
    await a.call("open", { what: "here", waitingOn: "me", next: "n", links }, ALICE_DM_1);
    await a.call(
      "open",
      { what: "elsewhere", waitingOn: "me", next: "n", links: ["knowledge:k0", "knowledge:k8"] },
      ALICE_THREAD,
    );
    await a.call(
      "open",
      { what: "elsewhere too", waitingOn: "me", next: "n", links: ["knowledge:k9"] },
      BOB_THREAD,
    );
    const messages = await a.recall(ALICE_DM_1);
    expect(seen).toEqual([...links.slice(0, 6), "knowledge:k9"]);
    expect(text(messages, HERE_ID)).toContain("knowledge:k1 → (x) knowledge:k2 knowledge:k3");
    expect(text(messages, STANDING_ID)).toContain("↳ knowledge:k0 (x)");
  });

  it("a reference too long for a standing line spends no lookup", async () => {
    const seen: string[] = [];
    const a = await agent({
      resolve: async (link) => {
        seen.push(link);
        return "(x)";
      },
    });
    const long = `knowledge:${"a".repeat(80)}`;
    // Due, so it is the first standing candidate and would take a lookup ahead of the six that follow.
    await a.call(
      "open",
      {
        what: "the due one",
        waitingOn: "me",
        next: "n",
        links: [long],
        revisit: { when: "in 1 minute" },
      },
      ALICE_THREAD,
    );
    const others = Array.from({ length: 6 }, (_, i) => `knowledge:k${i}`);
    for (const [i, link] of others.entries()) {
      clock += 1_000;
      await a.call(
        "open",
        { what: `fresh ${i}`, waitingOn: "me", next: "n", links: [link] },
        ALICE_THREAD,
      );
    }
    clock += 120_000;
    await a.recall(ALICE_DM_1);
    expect(seen).not.toContain(long);
    expect([...seen].sort()).toEqual(others);
  });

  it("a host resolver that fails is not called again that turn, so a hung one costs one timeout", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    const a = await agent({
      resolve: () => {
        calls++;
        return new Promise<string | null>(() => {});
      },
    });
    await a.call(
      "open",
      { what: "here", waitingOn: "me", next: "n", links: ["knowledge:a", "knowledge:b"] },
      ALICE_DM_1,
    );
    await a.call(
      "open",
      { what: "elsewhere", waitingOn: "me", next: "n", links: ["knowledge:c"] },
      ALICE_THREAD,
    );
    await a.call(
      "open",
      { what: "elsewhere too", waitingOn: "me", next: "n", links: ["knowledge:d"] },
      BOB_THREAD,
    );
    const started = Date.now();
    const messages = await a.recall(ALICE_DM_1);
    const elapsed = Date.now() - started;
    expect(calls).toBe(1);
    expect(elapsed).toBeLessThan(600);
    expect(text(messages, HERE_ID)).toContain("Links: knowledge:a knowledge:b");
    expect(text(messages, STANDING_ID)).not.toContain("↳");
  });

  it("standing spends its lookups on one link per loop, due loops first", async () => {
    const seen: string[] = [];
    const a = await agent({
      maxCharacters: 6_000,
      resolve: async (link) => {
        seen.push(link);
        return "(x)";
      },
    });
    for (let i = 0; i < 6; i++)
      await a.call(
        "open",
        {
          what: `plain ${i}`,
          waitingOn: "me",
          next: "n",
          links: [`knowledge:plain${i}a`, `knowledge:plain${i}b`],
        },
        ALICE_THREAD,
      );
    for (let i = 0; i < 2; i++)
      await a.call(
        "open",
        {
          what: `due ${i}`,
          waitingOn: "me",
          next: "n",
          links: [`knowledge:due${i}a`, `knowledge:due${i}b`],
          revisit: { when: "in 1 hour" },
        },
        LINEAR,
      );
    clock += 2 * 3_600_000;
    const standing = text(await a.recall(ALICE_DM_1), STANDING_ID);
    expect(seen).toHaveLength(6);
    expect(seen.slice(0, 2).sort()).toEqual(["knowledge:due0a", "knowledge:due1a"]);
    expect(seen.some((l) => l.endsWith("b"))).toBe(false);
    expect(standing).toContain("↳ knowledge:due0a (x)");
    expect(standing).toContain("↳ knowledge:due1a (x)");
  });

  it("the list tool shows the targets of a loop's references, by id and in a view", async () => {
    const a = await agent({
      resolve: async (link) => (link === "knowledge:acme" ? '"Acme" (Vendor, 5d)' : null),
    });
    const done = idOf(
      await a.call("open", { what: "ship the release", waitingOn: "me", next: "n" }, ALICE_DM_2),
    );
    await a.call("close", { id: done, outcome: "done", why: "shipped" }, ALICE_DM_2);
    const id = idOf(
      await a.call(
        "open",
        {
          what: "follow up",
          waitingOn: "me",
          next: "n",
          links: [`working:${done}`, "knowledge:acme"],
        },
        ALICE_DM_1,
      ),
    );
    const one = await a.call("list", { id }, ALICE_DM_1);
    expect(one).toContain(`working:${done} → "ship the release" (done, today)`);
    expect(one).toContain('knowledge:acme → "Acme" (Vendor, 5d)');
    expect(await a.call("list", { view: "here" }, ALICE_DM_1)).toContain(
      `working:${done} → "ship the release" (done, today)`,
    );
  });

  it("the list tool follows a working: reference by id, closed loops included", async () => {
    const a = await agent();
    const id = idOf(
      await a.call("open", { what: "the acme renewal", waitingOn: "acme", next: "n" }, ALICE_DM_2),
    );
    await a.call(
      "close",
      { id, outcome: "dropped", why: "superseded by the new plan" },
      ALICE_DM_2,
    );
    const one = await a.call("list", { id }, ALICE_DM_1);
    expect(one).toContain(`loop ${id}, dropped (superseded by the new plan)`);
    expect(one).toContain("the acme renewal");
    expect(await a.call("list", { view: "all" }, ALICE_DM_1)).not.toContain(id);
    expect(await a.call("list", { id: "Lffff" }, ALICE_DM_1)).toContain("No loop Lffff");
  });

  it("open tells the agent to cite the record a loop is about", () => {
    expect(workingToolSpecs.open.description).toContain("knowledge:<id>");
    expect(workingToolSpecs.list.description).toContain("working:<id>");
  });
});
