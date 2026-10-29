import type { SessionAuthContext } from "eve/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decideCommission, explain, openCommission, readCommission } from "./owner.js";
import { CommissionStore } from "./store.js";
import type { Conversation } from "./types.js";

// The commissioner's tools as eve calls them: a tool context carrying the session's verified auth.
const auth = (thread: string, principalId = "U-operator"): SessionAuthContext => ({
  authenticator: "slack",
  principalId,
  principalType: "user",
  attributes: { channel: "C1", thread },
});
const context = (thread = "1.0", callId = "call-1", principalId?: string) => ({
  session: {
    id: "session-1",
    auth: { current: auth(thread, principalId), initiator: auth(thread, principalId) },
  },
  callId,
});
type Context = Parameters<typeof openCommission>[2];
const stores: CommissionStore[] = [];
function setup() {
  const store = new CommissionStore(":memory:");
  stores.push(store);
  const prepare = vi.fn(async () => ({ issue: "ENG-1" }));
  const owner = {
    store,
    config: {
      worker: { id: "test-worker", prepare, handoff: async () => {} },
      // Only the operator commissions, as Felix; anyone else gets null.
      commissioner: (value: SessionAuthContext | null) =>
        value?.principalId === "U-operator"
          ? { id: "felix", conversation: value.attributes as Conversation }
          : null,
    },
  };
  return { owner, store, prepare };
}
const input = {
  spec: { brief: "Build labels", acceptance: ["Trim blanks"] },
  workReference: { kind: "linear-issue", id: "ENG-1" },
};
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("the commissioner's tools", () => {
  it("opens once per call, preparing the work only the first time, and records the conversation from auth", async () => {
    const { owner, store, prepare } = setup();
    const ctx = context() as unknown as Context;
    const first = await openCommission(owner, input, ctx);
    expect(await openCommission(owner, input, ctx)).toBe(first);
    expect(prepare).toHaveBeenCalledTimes(1);
    const id = /commission ([0-9a-f]{64})/.exec(first)?.[1] ?? "";
    expect(readCommission(owner, { commissionId: id }, ctx)).toContain("Build labels");
    expect(() =>
      readCommission(owner, { commissionId: id }, context("2.0") as unknown as Context),
    ).toThrow("conversation it was opened in");
    expect(store.read(id).handoff.status).toBe("pending");
  });

  it("refuses a session that can't commission, and leaves nothing behind when the worker refuses the work", async () => {
    const { owner, store, prepare } = setup();
    expect(
      await explain("open the commission", () =>
        openCommission(owner, input, context("1.0", "call-1", "U-stranger") as unknown as Context),
      ),
    ).toBe("Couldn't open the commission: This session can't commission work.");
    prepare.mockRejectedValueOnce(new Error("provider detail"));
    const refused = await explain("open the commission", () =>
      openCommission(owner, input, context("1.0", "call-2") as unknown as Context),
    );
    expect(refused).toBe(
      "Couldn't open the commission: The worker couldn't accept that work reference.",
    );
    expect(store.pendingOutbox()).toEqual([]);
  });

  it("shows a pending question in plain language and records the answer", async () => {
    const { owner, store } = setup();
    const ctx = context() as unknown as Context;
    const id = /commission ([0-9a-f]{64})/.exec(await openCommission(owner, input, ctx))?.[1] ?? "";
    store.consult({ commissionId: id, questionId: "q", question: { text: "Keep blanks?" } });
    expect(readCommission(owner, { commissionId: id }, ctx)).toContain("waiting for your answer");
    const decision = {
      commissionId: id,
      eventId: "a1",
      target: "question" as const,
      questionId: "q",
      decision: { answer: "No" },
    };
    expect(decideCommission(owner, decision, ctx)).toContain("Answered question q");
    expect(store.read(id).questions).toMatchObject([{ status: "answered", answer: "No" }]);
  });
});
