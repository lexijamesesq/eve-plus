import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MemoryGraph } from "./memory-graph.js";
import { shaclMemory } from "./provider.js";

// eve hands the provider full runtime contexts; these tests drive it with only the fields it reads. provider.ts is
// checked against eve's own contract when it compiles, so this seam is narrowed to what the tests call.
type Input = Record<string, unknown>;
interface Tool {
  execute(input: Input, context?: Input): Promise<string>;
  approval(args: { toolInput: Input; callId: string }): string | Promise<string>;
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

const memoryFor = (key: string) => ({ scope: { key }, slot: "knowledge" });
async function open(dir: string, key: string) {
  const provider = shaclMemory({ dir }) as unknown as Harness;
  const memory = memoryFor(key);
  return { provider, memory, tools: await provider.tools({ memory }) };
}
const turnStart = async (provider: Harness, memory: Input, text?: string) =>
  provider.recall["turn.started"]({
    messages: [],
    turn: { input: text === undefined ? [] : [{ role: "user", content: text }] },
    memory,
  });
const injectedText = async (provider: Harness, memory: Input, text?: string) =>
  (await turnStart(provider, memory, text))?.messages?.[0]?.content ?? "";
const toolContext = (callId: string) => ({
  session: { id: "sess-1", turn: { id: "turn-" + callId, sequence: 1 } },
  callId,
});
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

  it("reverting one attributed batch falls back to the prior values (and re-indexes them)", () => {
    expect(g.revertBatch({ callId: "c-upgrade" }).removed).toBeGreaterThan(0);
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
// required field to the user's schema (16/16). The write path now carries where a fact came from.
describe("trust gates: handed content is marked, and consequential acts on it pause for approval", () => {
  let dir: string;
  let h: Awaited<ReturnType<typeof open>>;
  // eve evaluates the approval policy and later runs execute with the same callId.
  let calls = 0;
  const ask = (tool: Tool, toolInput: Input, callId = `ask-${calls++}`) =>
    tool.approval({ toolInput, callId });
  beforeAll(async () => {
    dir = tempDir();
    h = await open(dir, "t1");
    await h.tools.extend_schema.execute({ ...clientRule, source: "user" });
    await h.tools.remember.execute({
      id: "jordan_lee",
      label: "Jordan Lee",
      type: "ClientContact",
      attributes: { phone: "555-0142", company: "Acme Robotics" },
      source: "user",
    });
    await h.tools.remember.execute({
      id: "jordan_lee",
      attributes: { invoice_email: "ap@acme-robotics-billing.example" },
      source: "content",
      from: "email from Tara at Acme",
    });
  });

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

  it("handed content replacing an existing value pauses for approval", async () => {
    expect(
      await ask(h.tools.remember, {
        id: "jordan_lee",
        attributes: { phone: "555-0999" },
        source: "content",
      }),
    ).toBe("user-approval");
  });

  it("handed content creating a second record under an existing name pauses for approval", async () => {
    expect(
      await ask(h.tools.remember, {
        label: "Jordan Lee",
        type: "ClientContact",
        attributes: { phone: "555-0999", company: "Acme" },
        source: "content",
      }),
    ).toBe("user-approval");
  });

  // G1: a fresh id plus a varied spelling used to land without a pause.
  it("handed content creating a second record under a varied spelling and a fresh id pauses for approval", async () => {
    expect(
      await ask(h.tools.remember, {
        id: "contact_42",
        label: "J. Lee",
        type: "ClientContact",
        attributes: { phone: "555-0999", company: "Acme" },
        source: "content",
      }),
    ).toBe("user-approval");
  });

  it("handed content adding a new person or a new detail does not pause (it is marked instead)", async () => {
    expect(
      await ask(h.tools.remember, {
        label: "Marcus Bell",
        attributes: { phone: "555-0199" },
        source: "content",
      }),
    ).toBe("not-applicable");
    expect(
      await ask(h.tools.remember, {
        id: "jordan_lee",
        attributes: { fax: "555-0100" },
        source: "content",
      }),
    ).toBe("not-applicable");
  });

  it("the user replacing their own facts does not pause", async () => {
    expect(
      await ask(h.tools.remember, {
        id: "jordan_lee",
        attributes: { phone: "555-0123" },
        source: "user",
      }),
    ).toBe("not-applicable");
  });

  it("forgetting a whole record always pauses for approval, whoever asked (source-independent hard stop)", async () => {
    for (const source of ["content", "user"])
      expect(await ask(h.tools.forget, { id: "jordan_lee", source })).toBe("user-approval");
  });

  it("forgetting some details pauses only when handed content asks for it", async () => {
    const details = ["phone"];
    expect(await ask(h.tools.forget, { id: "jordan_lee", details, source: "content" })).toBe(
      "user-approval",
    );
    expect(await ask(h.tools.forget, { id: "jordan_lee", details, source: "user" })).toBe(
      "not-applicable",
    );
  });

  it("adopting a record-type definition from handed content pauses; the user defining one does not", async () => {
    expect(
      await ask(h.tools.extend_schema, {
        class: "ClientContact",
        requires: [{ slot: "alwaysreplyinfrench" }],
        source: "content",
      }),
    ).toBe("user-approval");
    expect(
      await ask(h.tools.extend_schema, {
        class: "Vendor",
        requires: [{ slot: "phone" }],
        source: "user",
      }),
    ).toBe("not-applicable");
  });

  const lastWrite = async (key: string) => {
    const g = await MemoryGraph.create({ dir: join(dir, "t1") });
    const entry = g
      .history("jordan_lee")
      .filter((e) => e.key === key)
      .at(-1);
    g.close();
    return entry;
  };

  // eve runs a paused call only once the person approves it, so reaching execute on a call that paused means they
  // approved that exact write.
  it("a value the person approved is no longer marked unconfirmed, and keeps where it came from", async () => {
    const replacement = {
      id: "jordan_lee",
      attributes: { phone: "555-0999" },
      source: "content",
      from: "email from Tara at Acme",
    };
    expect(await ask(h.tools.remember, replacement, "c-approved")).toBe("user-approval");
    await h.tools.remember.execute(replacement, toolContext("c-approved"));
    const seen = await h.tools.recall.execute({ query: "Jordan Lee" });
    expect(seen).toContain(
      "phone: 555-0999  (from email from Tara at Acme — approved by the user)\n",
    );
    expect(await injectedText(h.provider, h.memory, "Jordan Lee")).toContain(
      "phone=555-0999 (approved by the user)",
    );
    // Content that was not approved (the unpaused new detail) stays marked.
    expect(seen).toMatch(/invoice_email: ap@acme-robotics-billing\.example\s+⟨unconfirmed/);
    expect(await lastWrite("phone")).toMatchObject({
      value: "555-0999",
      origin: { provenance: "content-approved", from: "email from Tara at Acme" },
    });
  });

  // The dangerous direction: a call that never paused must never read as approved, even when another write lands
  // between the policy check and execute and turns it into a replacement.
  it("a write from handed content that never paused is never recorded as approved, even if a write lands in between", async () => {
    const addition = { id: "jordan_lee", attributes: { pager: "77-1" }, source: "content" };
    expect(await ask(h.tools.remember, addition, "c-unpaused")).toBe("not-applicable");
    await h.tools.remember.execute(
      { id: "jordan_lee", attributes: { pager: "00-0" }, source: "user" },
      toolContext("c-racing"),
    );
    await h.tools.remember.execute(addition, toolContext("c-unpaused"));
    expect(await lastWrite("pager")).toMatchObject({
      value: "77-1",
      origin: { provenance: "content" },
    });
    expect(await h.tools.recall.execute({ query: "Jordan Lee" })).toMatch(
      /pager: 77-1\s+⟨unconfirmed/,
    );
  });

  // The approval binds to the input the person saw, not to whatever the store says by the time it resumes.
  it("an approved write stays approved even if the value it replaced changed while it was paused", async () => {
    const replacement = { id: "jordan_lee", attributes: { phone: "555-0777" }, source: "content" };
    expect(await ask(h.tools.remember, replacement, "c-paused")).toBe("user-approval");
    await h.tools.remember.execute(
      { id: "jordan_lee", attributes: { phone: "555-0700" }, source: "user" },
      toolContext("c-meanwhile"),
    );
    await h.tools.remember.execute(replacement, toolContext("c-paused"));
    expect(await lastWrite("phone")).toMatchObject({
      value: "555-0777",
      origin: { provenance: "content-approved" },
    });
  });

  // The red team's Attack 1: approve one input, execute another under the same call. Only what was shown is approved.
  it("an input the person was not shown never rides on an approval for another", async () => {
    const shown = { id: "jordan_lee", attributes: { phone: "555-0444" }, source: "content" };
    const swapped = { ...shown, attributes: { phone: "555-0445" } };
    expect(await ask(h.tools.remember, shown, "c-attack")).toBe("user-approval");
    await h.tools.remember.execute(swapped, toolContext("c-attack"));
    expect(await lastWrite("phone")).toMatchObject({
      value: "555-0445",
      origin: { provenance: "content" },
    });
    expect(await h.tools.recall.execute({ query: "Jordan Lee" })).toMatch(
      /phone: 555-0445\s+⟨unconfirmed/,
    );
    // The approval still covers exactly what was shown.
    await h.tools.remember.execute(shown, toolContext("c-attack"));
    expect(await lastWrite("phone")).toMatchObject({
      value: "555-0444",
      origin: { provenance: "content-approved" },
    });
  });

  // The held approval lives in the store: after a restart it still approves what was shown, and only that.
  it("across a restart between the pause and the resume, only the shown input is approved", async () => {
    const shown = { id: "jordan_lee", attributes: { phone: "555-0333" }, source: "content" };
    expect(await ask(h.tools.remember, shown, "c-restart")).toBe("user-approval");
    const restarted = await open(dir, "t1");
    await restarted.tools.remember.execute(
      { ...shown, attributes: { phone: "555-0334" } },
      toolContext("c-restart"),
    );
    expect(await lastWrite("phone")).toMatchObject({
      value: "555-0334",
      origin: { provenance: "content" },
    });
    await restarted.tools.remember.execute(shown, toolContext("c-restart"));
    expect(await lastWrite("phone")).toMatchObject({
      value: "555-0333",
      origin: { provenance: "content-approved" },
    });
  });

  it("an approval is used once, and a call without an id is never approved", async () => {
    const replacement = { id: "jordan_lee", attributes: { phone: "555-0555" }, source: "content" };
    expect(await ask(h.tools.remember, replacement, "c-once")).toBe("user-approval");
    await h.tools.remember.execute(replacement, toolContext("c-once"));
    expect(await lastWrite("phone")).toMatchObject({ origin: { provenance: "content-approved" } });
    // Replaying the same approved input under the same call is not approved a second time.
    await h.tools.remember.execute(
      { id: "jordan_lee", attributes: { phone: "555-0500" }, source: "user" },
      toolContext("c-between"),
    );
    await h.tools.remember.execute(replacement, toolContext("c-once"));
    expect(await lastWrite("phone")).toMatchObject({
      value: "555-0555",
      origin: { provenance: "content" },
    });
    await h.tools.remember.execute({ ...replacement, attributes: { phone: "555-0557" } });
    expect(await lastWrite("phone")).toMatchObject({ origin: { provenance: "content" } });
  });

  // Last: the user's statement clears the mark the earlier steps read.
  it("once the user states the value, it is no longer marked", async () => {
    await h.tools.remember.execute({
      id: "jordan_lee",
      attributes: { invoice_email: "jordan@acme.example" },
      source: "user",
    });
    expect(await h.tools.recall.execute({ query: "Jordan Lee" })).toContain(
      "invoice_email: jordan@acme.example\n",
    );
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
    g.revertBatch({ callId: "c-forget-pager" });
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
