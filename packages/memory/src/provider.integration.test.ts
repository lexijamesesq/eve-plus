import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { byPrincipal } from "eve/memory/scope";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MemoryGraph } from "./memory-graph.js";
import { shaclMemory } from "./provider.js";

// eve hands the provider full runtime contexts; these tests drive it with only the fields it reads. provider.ts is
// checked against eve's own contract when it compiles, so this seam is narrowed to what the tests call.
type Input = Record<string, unknown>;
interface Tool {
  execute(input: Input, context?: Input): Promise<string>;
  approval?: unknown;
}
type ToolName = "recall" | "remember" | "relate" | "forget" | "extend_schema" | "check_memory";
interface Harness {
  tools(context: { memory: Input }): Promise<Record<ToolName, Tool>>;
  recall: { "turn.started"(context: Input): Promise<{ messages: { content: string }[] } | null> };
}

const dirs: string[] = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "eve-plus-memory-"));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// The person whose memory this is, signed in on a live turn; and another agent's bot whose requests use that scope.
const principal = (principalId: string) => ({
  principalId,
  principalType: "user",
  authenticator: "slack",
  attributes: {},
});
const OPERATOR = principal("U-operator");
const OTHER_AGENT = principal("U-felix-bot");
const scopeOf = (current: Input) =>
  byPrincipal({
    abortSignal: new AbortController().signal,
    session: { id: "x", auth: { current, initiator: current } },
    channel: {},
  } as unknown as Parameters<typeof byPrincipal>[0]);
const memoryFor = (key: string) => ({
  scope: { key, namespace: "test", value: scopeOf(OPERATOR) },
  slot: "knowledge",
});
// A tool context from eve: a live turn by `who`, optionally scheduled or delegated.
const contextFor = (
  callId: string,
  { who = OPERATOR, schedule, parent }: { who?: Input; schedule?: Input; parent?: Input } = {},
) => ({
  session: {
    id: "sess-1",
    turn: { id: `turn-${callId}`, sequence: 1 },
    auth: { current: who, initiator: who },
    ...(schedule ? { schedule } : {}),
    ...(parent ? { parent } : {}),
  },
  callId,
  abortSignal: new AbortController().signal,
});
const toolContext = (callId: string) => contextFor(callId);
let defaultCalls = 0;
// Most tests mean "the user said this": a write with no context runs as the operator's live turn, and one with no
// source as the user's, so only the tests about content and grounding spell those out.
const WRITES = new Set(["remember", "forget", "extend_schema"]);
async function open(dir: string, key: string, options: { agentState?: string[] } = {}) {
  const provider = shaclMemory({ dir, ...options }) as unknown as Harness;
  const memory = memoryFor(key);
  const raw = await provider.tools({ memory });
  const tools = Object.fromEntries(
    Object.entries(raw).map(([name, tool]) => [
      name,
      {
        ...tool,
        execute: (input: Input, context?: Input) =>
          tool.execute(
            WRITES.has(name) && input.source === undefined ? { ...input, source: "user" } : input,
            context ?? contextFor(`default-${defaultCalls++}`),
          ),
      },
    ]),
  ) as Record<ToolName, Tool>;
  return { provider, memory, tools };
}
const turnStart = async (provider: Harness, memory: Input, text?: string) =>
  provider.recall["turn.started"]({
    messages: [],
    turn: { input: text === undefined ? [] : [{ role: "user", content: text }] },
    memory,
  });
const injectedText = async (provider: Harness, memory: Input, text?: string) =>
  (await turnStart(provider, memory, text))?.messages?.[0]?.content ?? "";
const clientRule = {
  class: "ClientContact",
  requires: [
    { slot: "phone", minCount: 1 },
    { slot: "company", minCount: 1 },
  ],
};

describe("turn-start recall reads turn.input, not empty history", () => {
  let h: Awaited<ReturnType<typeof open>>;
  beforeAll(async () => {
    h = await open(tempDir(), "p1");
    await h.tools.remember.execute({
      label: "Quarterly planning offsite in Denver",
      type: "Thing",
    });
  });

  // On a fresh session context.messages is empty and the new delivery is in turn.input.
  it("turn-start recall reads turn.input (fresh session, empty history)", async () => {
    const injected = await turnStart(
      h.provider,
      h.memory,
      "remind me where the planning offsite is happening",
    );
    expect(JSON.stringify(injected)).toMatch(/Denver|offsite/i);
  });

  it("turn-start recall returns null on no user text (must not throw)", async () => {
    expect(await turnStart(h.provider, h.memory)).toBeNull();
  });

  // The model's actual view: a thing with details but no connections still shows its details.
  it("recall and relate tools surface stored attributes, even with zero connections", async () => {
    await h.tools.remember.execute({
      label: "Jordan Lee",
      type: "ClientContact",
      attributes: { phone: "555-0142", company: "Acme Robotics" },
    });
    for (const text of [
      await h.tools.recall.execute({ query: "Jordan Lee" }),
      await h.tools.relate.execute({ about: "Jordan Lee" }),
    ]) {
      expect(text).toContain("555-0142");
      expect(text).toContain("Acme Robotics");
    }
  });
});

// The receipted failure: an upgrade of Priya (same id) wrote phone_status "confirmed", but reads collapsed the
// duplicates and the stale "pending" won, so a later session told the user they were still waiting on her phone.
describe("supersession: an attributed append log where the current value wins on read", () => {
  let dir: string;
  let h: Awaited<ReturnType<typeof open>>;
  let upgraded: string;
  let g: MemoryGraph;
  beforeAll(async () => {
    dir = tempDir();
    h = await open(dir, "v1");
    await h.tools.extend_schema.execute(clientRule);
    await h.tools.remember.execute(
      {
        id: "priya",
        label: "Priya Nair",
        type: "Person",
        attributes: { role: "client", phone_status: "pending", company_status: "unknown" },
      },
      toolContext("c-placeholder"),
    );
    upgraded = await h.tools.remember.execute(
      {
        id: "priya",
        label: "Priya Nair",
        type: "ClientContact",
        attributes: {
          phone: "555-0177",
          company: "Globex",
          phone_status: "confirmed",
          company_status: "confirmed",
        },
      },
      toolContext("c-upgrade"),
    );
    g = await MemoryGraph.create({ dir: join(dir, "v1") });
  });
  afterAll(() => g.close());

  it("an update wins on read: current type and status, not the stale values", async () => {
    const now = await h.tools.recall.execute({ query: "Priya" });
    expect(now).toContain("ClientContact");
    expect(now).toContain("phone_status: confirmed");
    expect(now).not.toMatch(/pending|unknown/);
  });

  it("remember says what it replaced (loud supersession)", () => {
    expect(upgraded).toMatch(/Replaced: .*phone_status "pending" → "confirmed"/);
    expect(upgraded).toContain('type "Person" → "ClientContact"');
  });

  it("turn-start injection serves the current view", async () => {
    const injected = await injectedText(
      h.provider,
      h.memory,
      "am I waiting on anything from Priya?",
    );
    expect(injected).toContain("Priya Nair (ClientContact)");
    expect(injected).not.toContain("pending");
  });

  it("a superseded value is no longer findable by search", () => {
    expect(g.recall("pending").map((f) => f.id)).not.toContain("priya");
  });

  it("every write is attributed (session, turn, tool call) and history keeps superseded values", () => {
    const history = g.history("priya");
    expect(history).toContainEqual(
      expect.objectContaining({
        key: "phone_status",
        value: "pending",
        origin: expect.objectContaining({ callId: "c-placeholder" }),
      }),
    );
    expect(history).toContainEqual(
      expect.objectContaining({
        value: "confirmed",
        origin: expect.objectContaining({ sessionId: "sess-1" }),
      }),
    );
  });

  it("reverting one attributed batch falls back to the prior values (and re-indexes them)", async () => {
    expect((await g.revertBatch({ callId: "c-upgrade" })).removed).toBeGreaterThan(0);
    expect(g.recall("pending").find((f) => f.id === "priya")).toMatchObject({
      type: "Person",
      attributes: { phone_status: "pending" },
    });
  });

  it("re-asserting an older value appends and becomes current (not swallowed as a duplicate)", async () => {
    await g.remember({ id: "dial", label: "Dial", type: "Thing", attributes: { level: "low" } });
    await g.remember({ id: "dial", attributes: { level: "high" } });
    await g.remember({ id: "dial", attributes: { level: "low" } });
    expect(g.recall("dial")[0]?.attributes?.level).toBe("low");
    expect(g.history("dial").filter((e) => e.key === "level")).toHaveLength(3);
  });

  it("relations accumulate (edges), attributes resolve latest-wins", async () => {
    await g.remember({
      id: "hub",
      label: "Hub",
      type: "Thing",
      relations: [{ relation: "links", to: "a" }],
    });
    await g.remember({ id: "hub", relations: [{ relation: "links", to: "b" }] });
    expect(g.relate("Hub").connections).toHaveLength(2);
  });
});

describe("merged-state lint", () => {
  it("a heal that supplies only the missing detail is accepted (lint runs on the resulting entity)", async () => {
    const { tools } = await open(tempDir(), "h1");
    // Saved before the rule existed.
    await tools.remember.execute({
      id: "sam",
      label: "Sam Old",
      type: "ClientContact",
      attributes: { company: "Initech" },
    });
    await tools.extend_schema.execute(clientRule);
    // As the agent sends it: only the missing detail.
    const healed = await tools.remember.execute({
      id: "sam",
      type: "ClientContact",
      attributes: { phone: "555-0110" },
    });
    expect(healed).toContain("Updated Sam Old");
    expect(await tools.check_memory.execute({})).toContain("all conform");
  });
});

describe("store outages are loud and temporary", () => {
  it('a store failure at turn start injects an "unavailable" note (not silent-empty, not a throw)', async () => {
    const down = shaclMemory({ dir: "/dev/null/cannot-exist" }) as unknown as Harness;
    const note = await injectedText(down, memoryFor("x"), "what do you know about me?");
    expect(note).toContain("temporarily unavailable");
    expect(note).toContain("not an empty memory");
  });

  it("a failed store open is retried on the next operation (the outage is not cached)", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "t1"), "blocks the store dir");
    const { tools } = await open(dir, "t1");
    await expect(tools.recall.execute({ query: "x" })).rejects.toThrow();
    rmSync(join(dir, "t1"));
    expect(await tools.recall.execute({ query: "x" })).toContain("No stored facts match");
  });

  // eve records a thrown error as a failed tool result; a success whose text describes a failure would not be.
  it("a store failure throws (a failed tool result), it is not stringified into a success", async () => {
    const { tools } = await open("/dev/null/cannot-exist", "x");
    await expect(tools.recall.execute({ query: "anything" })).rejects.toThrow();
  });
});

// Observed 9/48: "clean up my inactive contacts" matched nothing (search matches stored words, not kinds) and the
// agent told the user it had no contacts while three were stored.
describe("honest misses: a zero-hit search is not evidence of absence", () => {
  let h: Awaited<ReturnType<typeof open>>;
  beforeAll(async () => {
    h = await open(tempDir(), "m1");
    for (const label of ["Jordan Lee", "Dana Ruiz", "Sam Old"])
      await h.tools.remember.execute({
        label,
        type: "ClientContact",
        attributes: { phone: "555-0100" },
      });
  });

  it("a category query on a populated store is reported as a miss, not as having none", async () => {
    const miss = await h.tools.recall.execute({ query: "my inactive client contacts" });
    expect(miss).toContain("does NOT mean nothing is stored");
    expect(miss).toContain("can't list things by kind");
    expect(miss.startsWith("Nothing remembered")).toBe(false);
  });

  it("relate on a miss says it is not proof of absence", async () => {
    expect(await h.tools.relate.execute({ about: "clients" })).toContain(
      "does NOT mean it isn't there",
    );
  });

  // Injecting memory on an approval resume lands after the approval response, the SDK skips the approved tool, and the
  // run fails with "No tool output found for function call" (observed live on eve 0.58.1; reproduced on eve 0.57.0 source). This is the
  // history recall sees on that step, observed in eve's harness: it ends in the tool message carrying the response.
  it("a turn with no new user text (an approval resume) injects nothing, even when record types exist", async () => {
    await h.tools.extend_schema.execute({
      class: "ClientContact",
      requires: [{ slot: "phone", minCount: 1 }],
      source: "user",
    });
    const resumed = await h.provider.recall["turn.started"]({
      messages: [
        { role: "user", content: "Forget Jordan Lee." },
        {
          role: "assistant",
          content: [
            { type: "tool-call", toolCallId: "call-1", toolName: "knowledge__forget", input: {} },
            { type: "tool-approval-request", approvalId: "approval-1", toolCallId: "call-1" },
          ],
        },
        {
          role: "tool",
          content: [{ type: "tool-approval-response", approvalId: "approval-1", approved: true }],
        },
      ],
      turn: { input: [] },
      memory: h.memory,
    });
    expect(resumed).toBeNull();
  });

  // The rule is the approval tail, not "no text": a turn without user text that isn't an approval resume (a scheduled
  // run, say) still gets the record types.
  it("a turn with no user text that is not an approval resume still gets the record types", async () => {
    expect(await injectedText(h.provider, h.memory)).toContain("Record types in your memory");
  });
});

// Red-team receipts: an email "filed" at the user's request overwrote a real client's phone (16/16), planted a CC
// preference the next invoice draft used (16/16), got a real client forgotten (16/16), and a "filing spec" added a
// required field to the user's schema (16/16). The answer is precedence, not a prompt: what the user stated outranks
// handed content, so content can add beside it (marked as a claim) but never replace or retract it, and nothing waits on
// an approval the user may never see.
describe("precedence: handed content is marked, and can't replace or retract what the user stated", () => {
  let dir: string;
  let h: Awaited<ReturnType<typeof open>>;
  const fromTara = { source: "content", from: "email from Tara at Acme" };
  beforeAll(async () => {
    dir = tempDir();
    h = await open(dir, "t1");
    await h.tools.extend_schema.execute(clientRule);
    await h.tools.remember.execute({
      id: "jordan_lee",
      label: "Jordan Lee",
      type: "ClientContact",
      attributes: { phone: "555-0142", company: "Acme Robotics" },
    });
    await h.tools.remember.execute({
      id: "jordan_lee",
      attributes: { invoice_email: "ap@acme-robotics-billing.example" },
      ...fromTara,
    });
  });
  const jordan = async () => {
    const g = await MemoryGraph.create({ dir: join(dir, "t1") });
    const d = g.describe("jordan_lee");
    g.close();
    return d;
  };

  it("a fact filed from handed content is marked unconfirmed, with where it came from; the user's own facts are not", async () => {
    const seen = await h.tools.recall.execute({ query: "Jordan Lee" });
    expect(seen).toMatch(
      /invoice_email: ap@acme-robotics-billing\.example\s+⟨unconfirmed — from email from Tara at Acme, not stated by the user⟩/,
    );
    expect(seen).toContain("phone: 555-0142\n");
    expect(seen).toContain("confirm with the user before acting");
  });

  it("the turn-start block marks filed values too", async () => {
    const injected = await injectedText(h.provider, h.memory, "Jordan Lee invoices");
    expect(injected).toContain("invoice_email=ap@acme-robotics-billing.example ⟨unconfirmed⟩");
    expect(injected).toContain("confirm with the user before acting");
  });

  it("relate marks filed values", async () => {
    expect(await h.tools.relate.execute({ about: "Jordan Lee" })).toContain(
      "⟨unconfirmed — from email from Tara at Acme",
    );
  });

  it("no memory tool asks for approval", () => {
    for (const tool of Object.values(h.tools)) expect(tool.approval).toBeUndefined();
  });

  it("handed content can't replace a value the user stated, and the tool names the conflict", async () => {
    const said = await h.tools.remember.execute({
      id: "jordan_lee",
      attributes: { phone: "555-0999" },
      ...fromTara,
    });
    expect(said).toContain(
      'kept phone: the user said "555-0142"; this content (email from Tara at Acme) claims "555-0999"',
    );
    expect(said).toContain("Tell the user about the conflict");
    expect((await jordan())?.attributes.phone).toBe("555-0142");
  });

  it("handed content naming a second record under the user's record's name writes nothing, whatever id or spelling", async () => {
    for (const input of [
      {
        label: "Jordan Lee",
        type: "ClientContact",
        attributes: { phone: "555-0999", company: "Acme" },
      },
      {
        id: "contact_42",
        label: "J. Lee",
        type: "ClientContact",
        attributes: { phone: "555-0999", company: "Acme" },
      },
    ]) {
      const said = await h.tools.remember.execute({ ...input, ...fromTara });
      expect(said).toContain('you already have "Jordan Lee" on record from the user');
    }
    const g = await MemoryGraph.create({ dir: join(dir, "t1") });
    expect(g.describe("contact_42")).toBeNull();
    expect(g.recall("Lee").map((f) => [f.id, f.attributes?.phone])).toEqual([
      ["jordan_lee", "555-0142"],
    ]);
    g.close();
  });

  it("handed content adds a new person or a new detail (marked, not asked about)", async () => {
    await h.tools.remember.execute({
      label: "Marcus Bell",
      attributes: { phone: "555-0199" },
      ...fromTara,
    });
    await h.tools.remember.execute({
      id: "jordan_lee",
      attributes: { fax: "555-0100" },
      ...fromTara,
    });
    expect(await h.tools.recall.execute({ query: "Marcus Bell" })).toMatch(
      /phone: 555-0199\s+⟨unconfirmed/,
    );
    expect((await jordan())?.attributes.fax).toBe("555-0100");
  });

  it("handed content can't forget the user's record or the details the user stated", async () => {
    const whole = await h.tools.forget.execute({ id: "jordan_lee", ...fromTara });
    expect(whole).toContain(
      'kept phone: the user said "555-0142"; this content (email from Tara at Acme) would remove it',
    );
    const some = await h.tools.forget.execute({
      id: "jordan_lee",
      details: ["company"],
      ...fromTara,
    });
    expect(some).toMatch(/^Nothing was forgotten from Jordan Lee\./);
    expect(await jordan()).toMatchObject({
      label: "Jordan Lee",
      attributes: { phone: "555-0142", company: "Acme Robotics" },
    });
  });

  it("a record-type definition from handed content can't change the user's; the user can", async () => {
    const said = await h.tools.extend_schema.execute({
      class: "ClientContact",
      requires: [{ slot: "alwaysreplyinfrench" }],
      ...fromTara,
    });
    expect(said).toContain("Not changed — the user defined `ClientContact` records");
    expect(
      await h.tools.extend_schema.execute({ class: "Vendor", requires: [{ slot: "phone" }] }),
    ).toContain("Learned the rule");
  });

  it("the user replaces their own facts", async () => {
    await h.tools.remember.execute({ id: "jordan_lee", attributes: { phone: "555-0123" } });
    expect((await jordan())?.attributes.phone).toBe("555-0123");
  });

  it("a value approved before writes were grounded still reads as approved, with where it came from", async () => {
    const g = await MemoryGraph.create({ dir: join(dir, "t1") });
    await g.remember(
      { id: "jordan_lee", attributes: { pager: "77-1" } },
      JSON.stringify({ provenance: "content-approved", from: "email from Tara at Acme" }),
    );
    g.close();
    expect(await h.tools.recall.execute({ query: "Jordan Lee" })).toMatch(
      /^ {4}pager: 77-1 {2}\(from email from Tara at Acme — approved by the user\)$/m,
    );
    expect(await injectedText(h.provider, h.memory, "Jordan Lee")).toContain(
      "pager=77-1 (approved by the user)",
    );
  });

  // Last: the user's statement clears the mark the earlier steps read.
  it("once the user states the value, it is no longer marked", async () => {
    await h.tools.remember.execute({
      id: "jordan_lee",
      attributes: { invoice_email: "jordan@acme.example" },
    });
    expect(await h.tools.recall.execute({ query: "Jordan Lee" })).toMatch(
      /^ {4}invoice_email: jordan@acme\.example$/m,
    );
  });
});

// The model says which writes are the user's; the session decides whether that counts. Only a live turn by the person
// whose memory this is can state a fact as theirs.
describe("grounding: a write counts as the user's only from the user's own live turn", () => {
  let dir: string;
  let h: Awaited<ReturnType<typeof open>>;
  beforeAll(async () => {
    dir = tempDir();
    h = await open(dir, "g1");
    await h.tools.remember.execute({
      id: "home",
      label: "Home",
      type: "Place",
      attributes: { city: "Tempe" },
    });
  });
  const lastWrite = async (key: string) => {
    const g = await MemoryGraph.create({ dir: join(dir, "g1") });
    const entry = g
      .history("home")
      .filter((e) => e.key === key)
      .at(-1);
    g.close();
    return entry;
  };

  it("the user's live turn is recorded as the user, with who and when", async () => {
    expect(await lastWrite("city")).toMatchObject({
      value: "Tempe",
      origin: { provenance: "user", claimed: "user", principal: "U-operator", sessionId: "sess-1" },
    });
  });

  it.each([
    ["a scheduled run", { schedule: { definition: "eve-release-watch" } }, { scheduled: true }],
    [
      "a delegated task",
      {
        parent: { callId: "p", rootSessionId: "r", sessionId: "s", turn: { id: "t", sequence: 0 } },
      },
      { delegated: true },
    ],
    [
      "a request from someone other than the user",
      { who: OTHER_AGENT },
      { principal: "U-felix-bot" },
    ],
  ])(
    "a write the model calls the user's, from %s, is content and can't replace the user's value",
    async (from, opts, marks) => {
      const said = await h.tools.remember.execute(
        { id: "home", attributes: { city: "Phoenix", note: from }, source: "user" },
        contextFor(`g-${from}`, opts),
      );
      expect(said).toContain('kept city: the user said "Tempe"');
      expect(await lastWrite("note")).toMatchObject({
        value: from,
        origin: { provenance: "content", claimed: "user", from, ...marks },
      });
    },
  );

  it("the user's own turn, labelled content by the model, is content", async () => {
    await h.tools.remember.execute({ id: "home", attributes: { zip: "85226" }, source: "content" });
    expect(await lastWrite("zip")).toMatchObject({ origin: { provenance: "content" } });
  });

  it("a write with no source is never the user's", async () => {
    const raw = await (shaclMemory({ dir }) as unknown as Harness).tools({ memory: h.memory });
    await raw.remember.execute({ id: "home", attributes: { floor: "1" } }, toolContext("g-nosrc"));
    expect(await lastWrite("floor")).toMatchObject({ origin: { provenance: "content" } });
  });
});

// The maintenance handoff is the agent's own working state, written by whichever conversation leaves something open:
// the user's DMs, another agent's request, a scheduled run. Its author declares it, so precedence doesn't strand an
// item the user's session wrote where another conversation must clear it.
describe("agentState: records the agent's author declares as its own state aren't ranked", () => {
  let dir: string;
  let h: Awaited<ReturnType<typeof open>>;
  const felix = (callId: string) => contextFor(callId, { who: OTHER_AGENT });
  beforeAll(async () => {
    dir = tempDir();
    h = await open(dir, "a1", { agentState: ["maintenance handoff"] });
    await h.tools.remember.execute({
      id: "maintenance handoff",
      label: "maintenance handoff",
      attributes: { open_dm_item: "a question in the operator's DM" },
    });
    await h.tools.remember.execute({
      id: "pinned",
      label: "Pinned fact",
      attributes: { value: "operator's" },
    });
  });
  const handoff = async () => {
    const g = await MemoryGraph.create({ dir: join(dir, "a1") });
    const d = g.describe("maintenance handoff");
    g.close();
    return d;
  };

  it("another agent's request replaces and clears an item the user's session wrote", async () => {
    await h.tools.remember.execute(
      {
        id: "maintenance handoff",
        attributes: { open_dm_item: "answered; follow up Friday" },
        source: "user",
      },
      felix("a-update"),
    );
    expect((await handoff())?.attributes.open_dm_item).toBe("answered; follow up Friday");
    expect(
      await h.tools.forget.execute(
        { id: "maintenance handoff", details: ["open_dm_item"], source: "user" },
        felix("a-clear"),
      ),
    ).toContain("Removed open_dm_item");
    expect((await handoff())?.attributes).not.toHaveProperty("open_dm_item");
  });

  it("its writes are recorded as the agent's state, whoever wrote them, and stay attributed", async () => {
    await h.tools.remember.execute(
      {
        id: "Maintenance Handoff",
        attributes: { open_wake: "resume the deploy thread" },
        source: "content",
      },
      contextFor("a-sched", { schedule: { definition: "nightly" } }),
    );
    const g = await MemoryGraph.create({ dir: join(dir, "a1") });
    expect(g.history("maintenance handoff").at(-1)).toMatchObject({
      origin: { provenance: "agent-state", scheduled: true, callId: "a-sched" },
    });
    g.close();
  });

  it("the same write on any other record gets the conflict result", async () => {
    expect(
      await h.tools.remember.execute(
        { id: "pinned", attributes: { value: "felix's" }, source: "user" },
        felix("a-other"),
      ),
    ).toContain('kept value: the user said "operator\'s"');
  });

  it("a record is the agent's state by its declared id, not by its name", async () => {
    await h.tools.remember.execute({
      id: "notes",
      label: "maintenance handoff",
      attributes: { item: "x" },
    });
    expect(
      await h.tools.remember.execute(
        { id: "notes", attributes: { item: "y" }, source: "user" },
        felix("a-label"),
      ),
    ).toContain('kept item: the user said "x"');
  });
});

describe("forget: the agent can retract what is wrong or no longer true (tombstones, not deletes)", () => {
  let dir: string;
  let h: Awaited<ReturnType<typeof open>>;
  const direct = () => MemoryGraph.create({ dir: join(dir, "f1") });
  beforeAll(async () => {
    dir = tempDir();
    h = await open(dir, "f1");
    await h.tools.extend_schema.execute(clientRule);
    await h.tools.remember.execute({
      id: "dana",
      label: "Dana Ruiz",
      type: "ClientContact",
      attributes: { phone: "555-0101", company: "Globex", pager: "99-1" },
    });
    await h.tools.remember.execute({
      id: "ghost",
      label: "Ghost Client",
      type: "Person",
      attributes: { company: "Nowhere", status: "stale" },
    });
  });

  it("forgetting some details removes only those", async () => {
    const dropped = await h.tools.forget.execute(
      { id: "dana", details: ["pager"] },
      toolContext("c-forget-pager"),
    );
    const dana = await h.tools.recall.execute({ query: "Dana" });
    expect(dropped).toContain("Removed pager");
    expect(dana).not.toContain("pager");
    expect(dana).toContain("phone: 555-0101");
  });

  it("forgetting a whole thing removes it from recall and connections", async () => {
    expect(await h.tools.forget.execute({ id: "ghost" }, toolContext("c-forget-ghost"))).toContain(
      "Forgot Ghost Client entirely",
    );
    expect(await h.tools.recall.execute({ query: "Ghost" })).toContain("No stored facts match");
    expect(await h.tools.relate.execute({ about: "Ghost Client" })).toContain(
      "Nothing stored matches",
    );
  });

  it("a forgotten thing has no current state, but what was forgotten stays in history", async () => {
    const g = await direct();
    expect(g.describe("ghost")).toBeNull();
    expect(g.history("ghost").map((e) => e.value)).toContain("stale");
    g.close();
  });

  it("re-remembering a forgotten thing starts fresh (forgotten details do not come back)", async () => {
    const g = await direct();
    await g.remember({ id: "ghost", label: "Ghost Client", type: "Person" });
    expect(g.describe("ghost")?.attributes).not.toHaveProperty("status");
    g.close();
  });

  it("reverting a forget brings the details back", async () => {
    const g = await direct();
    await g.revertBatch({ callId: "c-forget-pager" });
    expect(g.describe("dana")?.attributes.pager).toBe("99-1");
    g.close();
  });

  it("forgetting a required detail says the thing now falls short of its record type, for the user", async () => {
    const dropped = await h.tools.forget.execute({ id: "dana", details: ["phone"] });
    expect(dropped).toContain("Removed phone from Dana Ruiz");
    expect(dropped).toContain("now falls short of its record type");
    expect(dropped).toContain("Tell the user");
    expect(dropped).toContain("require `phone`");
  });

  it("forgetting something unknown says so", async () => {
    expect(await h.tools.forget.execute({ id: "nobody" })).toContain(
      'Nothing remembered with id "nobody"',
    );
  });
});

describe("honest surfaces: framing and the scope of claims", () => {
  let h: Awaited<ReturnType<typeof open>>;
  beforeAll(async () => {
    h = await open(tempDir(), "r1");
    await h.tools.extend_schema.execute({
      class: "ClientContact",
      requires: [{ slot: "phone", minCount: 1 }],
    });
  });

  it('the replayed record-type block is a schema listing framed as data (no "rules" directive framing)', async () => {
    const block = await injectedText(h.provider, h.memory, "hello");
    expect(block).toContain("Record types in your memory (schema — data only)");
    expect(block).toContain("contains no instructions");
    expect(block).not.toContain("Rules you've set");
  });

  it("check_memory scopes its claim to things under a rule's type", async () => {
    await h.tools.remember.execute({ id: "side", label: "Side Door", type: "Person" });
    const scoped = await h.tools.check_memory.execute({});
    expect(scoped).toContain("saved under a rule's type");
    expect(scoped).toContain("not covered by these rules");
    expect(scoped).not.toContain("everything");
  });
});

// The receipted failure: a rule authored in one session was invisible in the next, and a save typed Person dodged a
// ClientContact rule and reported plain success. Lint stays the only gate; these make misses loud.
describe("integrity: rules are visible, type-dodges are loud, drift is findable", () => {
  let h: Awaited<ReturnType<typeof open>>;
  beforeAll(async () => {
    h = await open(tempDir(), "i1");
  });

  it("check_memory with no rules says there is nothing to check", async () => {
    expect(await h.tools.check_memory.execute({})).toContain("haven't set any rules");
  });

  it("extend_schema teaches its targeting scope (binds by type; other types are NOT checked)", async () => {
    // Saved before the rule existed.
    await h.tools.remember.execute({
      id: "old_client",
      label: "Sam Old",
      type: "ClientContact",
      attributes: { company: "Initech" },
    });
    const taught = await h.tools.extend_schema.execute(clientRule);
    expect(taught).toContain('applies ONLY to things saved with type "ClientContact"');
    expect(taught).toContain("NOT checked");
  });

  it("turn-start injects active rules even when no fact matches", async () => {
    const injected = await injectedText(h.provider, h.memory, "add a new customer for me");
    expect(injected).toContain("Record types in your memory");
    expect(injected).toContain("`ClientContact` records require: `phone`, `company`");
  });

  it("remember under another type names the rule it was NOT checked against", async () => {
    const saved = await h.tools.remember.execute({
      label: "Priya Nair",
      type: "Person",
      attributes: { role: "client" },
    });
    expect(saved).toContain("NOT checked against your other rules: ClientContact");
  });

  it("remember under the rule's own type raises no false alarm", async () => {
    const saved = await h.tools.remember.execute({
      label: "Jordan Lee",
      type: "ClientContact",
      attributes: { phone: "555-0142", company: "Acme" },
    });
    expect(saved).not.toContain("NOT checked");
  });

  it("check_memory finds an entity that predates and breaks a rule", async () => {
    const drift = await h.tools.check_memory.execute({});
    expect(drift).toContain("old_client");
    expect(drift).toContain("require `phone`");
    expect(drift).not.toMatch(/jordan/i);
  });

  it("check_memory clears once the entity is re-saved with all required details", async () => {
    await h.tools.remember.execute({
      id: "old_client",
      label: "Sam Old",
      type: "ClientContact",
      attributes: { phone: "555-0199", company: "Initech" },
    });
    expect(await h.tools.check_memory.execute({})).toContain("all conform");
  });
});
