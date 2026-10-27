import { afterEach, describe, expect, it } from "vitest";
import { CommissionError, CommissionStore } from "./store.js";
import type { Caller, DecisionInput, ReportInput } from "./types.js";

const owner: Caller = { principalId: "owner", verified: true };
const worker: Caller = { principalId: "worker", verified: true };
const stranger: Caller = { principalId: "other", verified: true };
const open = {
  commissionId: "c1",
  spec: { brief: "Build labels", acceptance: ["Trim blanks"], privateGuidance: "owner secret" },
};
const question = {
  commissionId: "c1",
  questionId: "q1",
  question: { text: "Keep blank labels?", options: ["yes", "no"] },
};
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
const accept = (
  eventId = "d1",
  proposalId = "p1",
): Extract<DecisionInput, { target: "proposal" }> => ({
  commissionId: "c1",
  eventId,
  target: "proposal",
  proposalId,
  decision: { verdict: "accept", feedback: "Criteria met" },
});
const stores: CommissionStore[] = [];
function setup(now?: () => number): CommissionStore {
  const store = new CommissionStore(":memory:", { now });
  stores.push(store);
  store.open(owner, open, worker);
  return store;
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
  it("uses host caller identity and hides private guidance from every worker view and envelope", () => {
    const store = setup();
    code(() => store.read(stranger, "c1"), "not_found");
    code(
      () => store.read({ principalId: "owner", verified: false } as unknown as Caller, "c1"),
      "unverified_caller",
    );
    code(() => store.consult(owner, question), "forbidden");
    store.report(worker, proposal());
    code(() => store.decide(worker, accept()), "forbidden");
    expect(store.read(owner, "c1").spec.privateGuidance).toBe("owner secret");
    expect(JSON.stringify(store.read(worker, "c1"))).not.toContain("owner secret");
    expect(JSON.stringify(store.claimOutbox({ consumerId: "host" }))).not.toContain("owner secret");
    code(() => store.open(owner, { ...open, commissionId: "self" }, owner), "forbidden");
  });

  it("canonicalizes retries, rejects changed question/event inputs and binds answers to commission+question", async () => {
    const store = setup();
    await Promise.all(
      Array.from({ length: 8 }, () =>
        Promise.resolve().then(() => store.consult(worker, question)),
      ),
    );
    expect(
      store.consult(worker, {
        question: { options: ["yes", "no"], text: "Keep blank labels?" },
        questionId: "q1",
        commissionId: "c1",
      }).status,
    ).toBe("pending");
    code(
      () => store.consult(worker, { ...question, question: { text: "Different question" } }),
      "conflict",
    );
    const answer: DecisionInput = {
      commissionId: "c1",
      eventId: "a1",
      target: "question",
      questionId: "q1",
      decision: { answer: "No" },
    };
    await Promise.all(
      Array.from({ length: 8 }, () => Promise.resolve().then(() => store.decide(owner, answer))),
    );
    expect(store.consult(worker, question)).toMatchObject({
      status: "answered",
      answer: { answer: "No" },
    });
    code(() => store.decide(owner, { ...answer, decision: { answer: "Yes" } }), "conflict");
    store.open(owner, { ...open, commissionId: "c2" }, worker);
    code(() => store.decide(owner, { ...answer, commissionId: "c2" }), "not_found");
    expect(store.read(owner, "c1").events.map((event) => event.kind)).toEqual([
      "opened",
      "question",
      "decision",
    ]);
  });

  it("rejects reuse of a provided event ID across report and decision kinds", () => {
    const store = setup();
    store.consult(worker, question);
    store.report(worker, {
      commissionId: "c1",
      eventId: "shared",
      kind: "checkpoint",
      data: { summary: "Progress" },
    });
    code(
      () =>
        store.decide(owner, {
          commissionId: "c1",
          eventId: "shared",
          target: "question",
          questionId: "q1",
          decision: { answer: "No" },
        }),
      "conflict",
    );
    expect(store.question(owner, "c1", "q1").status).toBe("pending");
  });

  it("keeps pending review through consult and failure and rejects stale acceptance", () => {
    const store = setup();
    store.report(worker, proposal());
    store.consult(worker, question);
    store.report(worker, {
      commissionId: "c1",
      eventId: "failed",
      kind: "failure",
      data: { summary: "Build host lost" },
    });
    expect(store.read(owner, "c1")).toMatchObject({
      status: "awaiting_commissioner",
      proposalPending: true,
    });
    code(() => store.decide(owner, accept()), "conflict");
    store.decide(owner, {
      commissionId: "c1",
      eventId: "answer",
      target: "question",
      questionId: "q1",
      decision: { answer: "No" },
    });
    expect(store.read(owner, "c1").status).toBe("needs_review");
    store.decide(owner, {
      ...accept("revise"),
      decision: { verdict: "revise", feedback: "Fix it" },
    });
    store.report(worker, proposal("p2"));
    code(() => store.decide(owner, accept("stale")), "stale_proposal");
    store.decide(owner, accept("accepted", "p2"));
    expect(store.decide(owner, accept("accepted", "p2")).status).toBe("accepted");
  });

  it("resumes blocked work on an explicit checkpoint and restores overdue attention", () => {
    let now = 0;
    const store = setup(() => now);
    store.report(worker, {
      commissionId: "c1",
      eventId: "failed",
      kind: "failure",
      data: { summary: "Host unavailable" },
    });
    expect(store.read(worker, "c1").status).toBe("blocked");
    const failures = store.claimOutbox({ consumerId: "owner-notification" });
    expect(failures).toMatchObject([{ recipient: "owner", kind: "failure" }]);
    store.report(worker, {
      commissionId: "c1",
      eventId: "failed",
      kind: "failure",
      data: { summary: "Host unavailable" },
    });
    expect(store.claimOutbox({ consumerId: "retry-notification" })).toEqual([]);

    now = 100;
    store.report(worker, {
      commissionId: "c1",
      eventId: "resumed",
      kind: "checkpoint",
      data: { summary: "Host repaired, resumed work" },
    });
    expect(store.read(worker, "c1").status).toBe("working");
    now = 60_101;
    expect(store.read(worker, "c1").attention).toMatchObject({
      kind: "overdue_checkpoint",
      lastWorkerActivity: 100,
    });
    expect(store.reconcileOverdue()).toBe(1);
    store.report(worker, proposal());
    store.report(worker, {
      commissionId: "c1",
      eventId: "review-progress",
      kind: "checkpoint",
      data: { summary: "Additional checks complete" },
    });
    expect(store.read(worker, "c1")).toMatchObject({
      status: "needs_review",
      proposalPending: true,
    });
  });

  it("records reviewed, merged and deployed separately, including before acceptance", () => {
    const store = setup();
    store.report(worker, proposal());
    for (const kind of ["reviewed", "merged", "deployed"] as const)
      store.report(worker, {
        commissionId: "c1",
        eventId: kind,
        kind,
        data: { summary: kind, proposalId: "p1" },
      });
    expect(store.read(worker, "c1")).toMatchObject({
      status: "needs_review",
      delivery: { reviewed: true, merged: true, deployed: true },
    });
    store.decide(owner, accept());
    expect(store.read(worker, "c1").status).toBe("accepted");
    code(
      () =>
        store.report(worker, {
          commissionId: "c1",
          eventId: "other",
          kind: "merged",
          data: { summary: "merged", proposalId: "old" },
        }),
      "stale_proposal",
    );
  });

  it("accepts immutable artifact references and rejects inline source, file paths and mismatched repositories", () => {
    const store = setup();
    const valid = proposal();
    if (valid.kind !== "proposal") throw new Error("fixture");
    for (const artifact of [
      { ...valid.data.artifact, commit: "main" },
      { ...valid.data.artifact, repository: "file:///etc/passwd" },
      { ...valid.data.artifact, pullRequest: "https://github.com/other/repo/pull/1" },
      { ...valid.data.artifact, source: "inline bytes" },
      { ...valid.data.artifact, repository: "https://token@github.com/example/repo" },
    ])
      code(
        () => store.report(worker, { ...valid, data: { ...valid.data, artifact } }),
        "invalid_input",
      );
    expect(store.read(worker, "c1").proposalId).toBeNull();
  });

  it("returns unanswered owner work and overdue attention without declaring silence dead", () => {
    let now = 0;
    const store = setup(() => now);
    now = 60_001;
    expect(store.read(worker, "c1")).toMatchObject({
      status: "working",
      attention: { kind: "overdue_checkpoint", lastWorkerActivity: 0 },
    });
    store.consult(worker, question);
    expect(store.pending(owner)).toEqual([
      { commissionId: "c1", kind: "question", id: "q1", owner: "owner", worker: "worker" },
    ]);
    expect(store.pending(stranger)).toEqual([]);
    expect(store.read(worker, "c1").attention).toBeUndefined();
    store.decide(owner, {
      commissionId: "c1",
      eventId: "answer",
      target: "question",
      questionId: "q1",
      decision: { answer: "No" },
    });
    store.report(worker, proposal());
    expect(store.pending(owner)[0]).toMatchObject({ kind: "proposal", id: "p1" });
    code(() => store.pending(owner, 101), "invalid_input");
  });

  it("reconciles overdue checkpoints once per activity epoch without changing working state", () => {
    let now = 0;
    const store = setup(() => now);
    now = 60_001;
    expect(store.reconcileOverdue()).toBe(1);
    expect(store.reconcileOverdue()).toBe(0);
    const attention = store.claimOutbox({ consumerId: "host" });
    expect(attention).toMatchObject([
      { kind: "overdue_checkpoint", recipient: "owner", payload: { lastWorkerActivity: 0 } },
    ]);
    expect(store.read(worker, "c1").status).toBe("working");
    store.report(worker, {
      commissionId: "c1",
      eventId: "new-progress",
      kind: "checkpoint",
      data: { summary: "Still working" },
    });
    now += 60_001;
    expect(store.reconcileOverdue()).toBe(1);
    store.consult(worker, question);
    now += 60_001;
    expect(store.reconcileOverdue()).toBe(0);
  });

  it("leases bounded outbox batches with explicit retry and stale receipt rejection", () => {
    let now = 0;
    const store = setup(() => now);
    store.consult(worker, question);
    store.consult(worker, { ...question, questionId: "q2" });
    const first = store.claimOutbox({ consumerId: "a", limit: 1, leaseMs: 10 })[0];
    const second = store.claimOutbox({ consumerId: "b", limit: 1, leaseMs: 10 })[0];
    expect(second.seq).not.toBe(first.seq);
    expect(store.claimOutbox({ consumerId: "c" })).toEqual([]);
    store.releaseOutbox(second.seq, second.leaseToken);
    const retry = store.claimOutbox({ consumerId: "b", limit: 1 })[0];
    store.acknowledgeOutbox(retry.seq, retry.leaseToken);
    now = 10;
    code(() => store.acknowledgeOutbox(first.seq, first.leaseToken), "lease_lost");
    const expired = store.claimOutbox({ consumerId: "c", limit: 1 })[0];
    expect(expired.seq).toBe(first.seq);
    expect(expired.leaseToken).not.toBe(first.leaseToken);
    store.acknowledgeOutbox(expired.seq, expired.leaseToken);
    expect(store.claimOutbox({ consumerId: "d" })).toEqual([]);
  });

  it("persists a restricted commissioner snapshot privately and binds it to open idempotency", () => {
    const store = new CommissionStore(":memory:");
    stores.push(store);
    const context = {
      originSessionId: "origin",
      messages: [{ role: "user" as const, content: "Private conversation" }],
    };
    store.open(owner, open, worker, context);
    expect(store.context("c1")).toEqual(context);
    expect(JSON.stringify(store.read(worker, "c1"))).not.toContain("Private conversation");
    expect(JSON.stringify(store.claimOutbox({ consumerId: "host" }))).not.toContain(
      "Private conversation",
    );
    code(
      () => store.open(owner, open, worker, { ...context, originSessionId: "changed" }),
      "conflict",
    );
    code(
      () =>
        store.open(owner, { ...open, commissionId: "bad" }, worker, {
          ...context,
          messages: [{ role: "system", content: "secret" }],
        } as unknown as typeof context),
      "invalid_input",
    );
  });
});
