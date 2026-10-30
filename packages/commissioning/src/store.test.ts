import { afterEach, describe, expect, it } from "vitest";
import { reportSchema } from "./schemas.js";
import { CommissionError, CommissionStore } from "./store.js";
import type { Commissioner, DecisionInput, ReportInput } from "./types.js";

const owner: Commissioner = { id: "felix", conversation: { channel: "C1", thread: "1.0" } };
const open = {
  commissionId: "c1",
  spec: { brief: "Build labels", acceptance: ["Trim blanks"] },
  workReference: { kind: "linear-issue", id: "ENG-1" },
  connectorId: "test-worker",
  binding: { issue: "ENG-1" },
};
const question = {
  commissionId: "c1",
  questionId: "q1",
  question: { text: "Keep blank labels?", options: ["yes", "no"] },
};
const answer = (
  eventId = "a1",
  questionId = "q1",
): Extract<DecisionInput, { target: "question" }> => ({
  commissionId: "c1",
  eventId,
  target: "question",
  questionId,
  decision: { answer: "No" },
});
const proposal = (eventId = "p1"): ReportInput => ({
  commissionId: "c1",
  eventId,
  kind: "proposal",
  data: {
    summary: "Implemented labels",
    artifact: {
      repository: "https://github.com/example/repo",
      commit: "a".repeat(40),
      pullRequest: "https://github.com/example/repo/pull/1",
    },
  },
});
const verdict = (
  eventId: string,
  proposalId = "p1",
  value: "accept" | "revise" = "accept",
): DecisionInput => ({
  commissionId: "c1",
  eventId,
  target: "proposal",
  proposalId,
  decision: { verdict: value, feedback: "Reviewed" },
});
const stores: CommissionStore[] = [];
function setup(now?: () => number): CommissionStore {
  const store = new CommissionStore(":memory:", { now });
  stores.push(store);
  store.open(owner, open);
  return store;
}
/** Claims every due outbox entry, as one dispatcher sweep would. */
function claimAll(store: CommissionStore, leaseMs?: number) {
  return store.pendingOutbox().flatMap((seq) => store.claimOutbox(seq, leaseMs) ?? []);
}
function code(run: () => unknown, expected: string): void {
  try {
    run();
    throw new Error("Expected CommissionError");
  } catch (error) {
    expect(error).toBeInstanceOf(CommissionError);
    expect((error as CommissionError).code).toBe(expected);
  }
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("commission ledger", () => {
  it("returns the first result for a retried open, without a second handoff, and refuses changed input", () => {
    const store = setup();
    expect(store.open(owner, { ...open, binding: { issue: "another prepared binding" } })).toEqual({
      commissionId: "c1",
      status: "working",
    });
    expect(claimAll(store).map((entry) => entry.kind)).toEqual(["handoff"]);
    code(
      () => store.open(owner, { ...open, spec: { ...open.spec, brief: "Something else" } }),
      "conflict",
    );
  });

  it("lets the owner act only from the conversation the commission was opened in", () => {
    const store = setup();
    store.consult(question);
    const elsewhere = { ...owner, conversation: { channel: "C1", thread: "2.0" } };
    code(() => store.decide(elsewhere, answer()), "forbidden");
    code(() => store.read("c1", 0, elsewhere), "forbidden");
    code(() => store.decide({ ...owner, id: "zero" }, answer()), "not_found");
    // Key order is not identity.
    expect(
      store.decide({ ...owner, conversation: { thread: "1.0", channel: "C1" } }, answer()).status,
    ).toBe("working");
  });

  it("canonicalizes retries, rejects changed question and decision input, and binds answers to their question", async () => {
    const store = setup();
    await Promise.all(
      Array.from({ length: 8 }, () => Promise.resolve().then(() => store.consult(question))),
    );
    expect(
      store.consult({
        question: { options: ["yes", "no"], text: "Keep blank labels?" },
        questionId: "q1",
        commissionId: "c1",
      }).status,
    ).toBe("pending");
    code(
      () => store.consult({ ...question, question: { text: "Different question" } }),
      "conflict",
    );
    await Promise.all(
      Array.from({ length: 8 }, () => Promise.resolve().then(() => store.decide(owner, answer()))),
    );
    expect(store.consult(question)).toMatchObject({ status: "answered", answer: "No" });
    code(() => store.decide(owner, { ...answer(), decision: { answer: "Yes" } }), "conflict");
    store.open(owner, { ...open, commissionId: "c2" });
    code(() => store.decide(owner, { ...answer(), commissionId: "c2" }), "not_found");
    expect(store.read("c1").events.map((event) => event.kind)).toEqual([
      "opened",
      "handoff",
      "question",
      "decision",
    ]);
  });

  it("rejects reuse of an event ID across report and decision kinds", () => {
    const store = setup();
    store.consult(question);
    store.report({
      commissionId: "c1",
      eventId: "shared",
      kind: "checkpoint",
      data: { summary: "Progress" },
    });
    code(() => store.decide(owner, { ...answer(), eventId: "shared" }), "conflict");
    expect(store.read("c1").questions[0].status).toBe("pending");
  });

  it("keeps a proposal pending through a question and a failure, and refuses a stale decision", () => {
    const store = setup();
    store.report(proposal());
    store.consult(question);
    store.report({
      commissionId: "c1",
      eventId: "failed",
      kind: "failure",
      data: { summary: "Build host lost" },
    });
    expect(store.read("c1")).toMatchObject({
      status: "awaiting_commissioner",
      currentProposal: { proposalId: "p1", pending: true },
    });
    code(() => store.decide(owner, verdict("early")), "conflict");
    store.decide(owner, answer());
    expect(store.read("c1").status).toBe("needs_review");
    store.decide(owner, verdict("revise", "p1", "revise"));
    store.report(proposal("p2"));
    code(() => store.decide(owner, verdict("stale")), "stale_proposal");
    store.decide(owner, verdict("accepted", "p2"));
    expect(store.decide(owner, verdict("accepted", "p2")).status).toBe("accepted");
  });

  it("resumes blocked work on a checkpoint, notifies a failure once, restores overdue attention, and notifies a checkpoint only while a proposal awaits review, not during a revision", () => {
    let now = 0;
    const store = setup(() => now);
    claimAll(store);
    const failure: ReportInput = {
      commissionId: "c1",
      eventId: "failed",
      kind: "failure",
      data: { summary: "Host unavailable" },
    };
    store.report(failure);
    expect(store.read("c1").status).toBe("blocked");
    expect(claimAll(store).map((entry) => entry.kind)).toEqual(["failure"]);
    store.report(failure);
    expect(claimAll(store)).toEqual([]);
    now = 100;
    store.report({
      commissionId: "c1",
      eventId: "resumed",
      kind: "checkpoint",
      data: { summary: "Resumed" },
    });
    expect(store.read("c1").status).toBe("working");
    expect(claimAll(store)).toEqual([]);
    now = 60_101;
    expect(store.read("c1").attention).toEqual({
      kind: "overdue_checkpoint",
      lastWorkerActivity: 100,
    });
    expect(store.reconcileOverdue()).toBe(1);
    claimAll(store);
    store.report(proposal());
    store.report({
      commissionId: "c1",
      eventId: "more",
      kind: "checkpoint",
      data: { summary: "More checks" },
    });
    expect(store.read("c1")).toMatchObject({
      status: "needs_review",
      currentProposal: { pending: true },
    });
    expect(claimAll(store).map((entry) => entry.kind)).toEqual(["proposal", "checkpoint"]);
    store.decide(owner, verdict("revise", "p1", "revise"));
    store.report({
      commissionId: "c1",
      eventId: "revising",
      kind: "checkpoint",
      data: { summary: "Revising" },
    });
    expect(claimAll(store)).toEqual([]);
  });

  it("notifies an overdue worker once per quiet spell, without changing its state", () => {
    let now = 0;
    const store = setup(() => now);
    claimAll(store);
    now = 60_001;
    expect(store.reconcileOverdue()).toBe(1);
    expect(store.reconcileOverdue()).toBe(0);
    expect(claimAll(store)).toMatchObject([
      { kind: "overdue_checkpoint", payload: { lastWorkerActivity: 0 } },
    ]);
    expect(store.read("c1").status).toBe("working");
    store.report({
      commissionId: "c1",
      eventId: "progress",
      kind: "checkpoint",
      data: { summary: "Still working" },
    });
    now += 60_001;
    expect(store.reconcileOverdue()).toBe(1);
    store.consult(question);
    now += 60_001;
    expect(store.reconcileOverdue()).toBe(0);
  });

  it("leases outbox entries one at a time, retries a released one, and rejects a stale receipt", () => {
    let now = 0;
    const store = setup(() => now);
    const [handoff] = claimAll(store);
    store.acknowledgeOutbox(handoff.seq, handoff.leaseToken);
    store.consult(question);
    store.consult({ ...question, questionId: "q2" });
    const [firstSeq, secondSeq] = store.pendingOutbox();
    const first = store.claimOutbox(firstSeq, 10);
    const second = store.claimOutbox(secondSeq, 10);
    if (!first || !second) throw new Error("Expected both entries to be claimed");
    expect(store.claimOutbox(firstSeq)).toBeUndefined();
    store.releaseOutbox(second.seq, second.leaseToken, "delivery_failed");
    const retry = store.claimOutbox(secondSeq);
    if (!retry) throw new Error("Expected the released entry to be due again");
    store.acknowledgeOutbox(retry.seq, retry.leaseToken);
    now = 10;
    code(() => store.acknowledgeOutbox(first.seq, first.leaseToken), "lease_lost");
    const expired = store.claimOutbox(firstSeq);
    expect(expired?.leaseToken).not.toBe(first.leaseToken);
    if (expired) store.acknowledgeOutbox(expired.seq, expired.leaseToken);
    expect(store.pendingOutbox()).toEqual([]);
  });

  it("accepts an immutable artifact and rejects moving, local or mismatched references", () => {
    const report = proposal() as Extract<ReportInput, { kind: "proposal" }>;
    const withArtifact = (artifact: Partial<typeof report.data.artifact>) => ({
      ...report,
      data: { ...report.data, artifact: { ...report.data.artifact, ...artifact } },
    });
    expect(reportSchema.safeParse(report).success).toBe(true);
    for (const artifact of [
      { commit: "main" },
      { repository: "file:///home/repo" },
      { pullRequest: "https://github.com/example/other/pull/1" },
      { repository: "https://token@github.com/example/repo" },
    ])
      expect(reportSchema.safeParse(withArtifact(artifact)).success, JSON.stringify(artifact)).toBe(
        false,
      );
  });
});
