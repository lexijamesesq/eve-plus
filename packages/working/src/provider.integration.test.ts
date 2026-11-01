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
import { WorkingStore, workingStorePath } from "./store.js";

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
