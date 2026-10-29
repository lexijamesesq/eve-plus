import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { CommissionError, CommissionStore } from "./store.js";
import type { Commissioner, DecisionInput, ReportInput } from "./types.js";

const owner: Commissioner = { id: "felix", conversation: { channel: "C1", thread: "1.0" } };
const input = {
  commissionId: "recover",
  spec: { brief: "Build", acceptance: ["Works"] },
  workReference: { kind: "linear-issue", id: "ENG-1" },
  connectorId: "test-worker",
  binding: { issue: "ENG-1" },
};
const question = { commissionId: "recover", questionId: "q", question: { text: "Which option?" } };
const answer: DecisionInput = {
  commissionId: "recover",
  eventId: "answer",
  target: "question",
  questionId: "q",
  decision: { answer: "Option A" },
};
const proposal = (eventId: string): ReportInput => ({
  commissionId: "recover",
  eventId,
  kind: "proposal",
  data: {
    summary: "Proposed",
    artifact: {
      repository: "https://example.test/repo",
      commit: "a".repeat(40),
      pullRequest: "https://example.test/repo/pull/1",
    },
  },
});
const paths: string[] = [];
function path(): string {
  const dir = mkdtempSync(join(tmpdir(), "commissioning-"));
  paths.push(dir);
  return join(dir, "nested", "ledger.sqlite");
}
function claimAll(store: CommissionStore, leaseMs?: number) {
  return store.pendingOutbox().flatMap((seq) => store.claimOutbox(seq, leaseMs) ?? []);
}
afterEach(() => {
  for (const dir of paths.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("on-disk commissioning ledger", () => {
  it("lets one of two handles claim an entry, never reclaims an acknowledged one, and applies a decision once", () => {
    const file = path();
    let now = 1;
    const first = new CommissionStore(file, { now: () => now });
    const second = new CommissionStore(file, { now: () => now });
    try {
      first.open(owner, input);
      second.consult(question);
      first.consult(question);
      const seqs = first.pendingOutbox();
      const claimed = seqs.flatMap((seq) => second.claimOutbox(seq, 10) ?? []);
      expect(claimed.map((entry) => entry.kind)).toEqual(["handoff", "question"]);
      expect(seqs.map((seq) => first.claimOutbox(seq))).toEqual([undefined, undefined]);
      for (const entry of claimed) second.acknowledgeOutbox(entry.seq, entry.leaseToken);
      now = 12;
      expect(first.pendingOutbox()).toEqual([]);
      second.decide(owner, answer);
      first.decide(owner, answer);
      expect(first.read("recover").events.map((event) => event.kind)).toEqual([
        "opened",
        "handoff",
        "question",
        "decision",
      ]);
    } finally {
      first.close();
      second.close();
    }
  });

  it("gives a late answer a full grace interval, and keeps its overdue notice deduplicated across reopen", () => {
    const file = path();
    let now = 0;
    let store = new CommissionStore(file, { now: () => now });
    try {
      store.open(owner, input);
      store.consult(question);
      now = 100_000;
      expect(store.reconcileOverdue()).toBe(0);
      store.decide(owner, answer);
      expect(store.reconcileOverdue()).toBe(0);
      now += 60_001;
      expect(store.read("recover").attention).toEqual({
        kind: "overdue_checkpoint",
        lastWorkerActivity: 0,
      });
      expect(store.reconcileOverdue()).toBe(1);
      store.close();
      store = new CommissionStore(file, { now: () => now });
      expect(store.reconcileOverdue()).toBe(0);
      store.report({
        commissionId: "recover",
        eventId: "resumed",
        kind: "checkpoint",
        data: { summary: "Again" },
      });
      expect(store.read("recover").attention).toBeUndefined();
      now += 60_001;
      expect(store.reconcileOverdue()).toBe(1);
    } finally {
      store.close();
    }
  });

  it("lets a requested revision go overdue, but not review, blocked or accepted work", () => {
    let now = 0;
    const store = new CommissionStore(path(), { now: () => now });
    try {
      store.open(owner, input);
      store.report(proposal("p1"));
      now = 100_000;
      expect(store.reconcileOverdue()).toBe(0);
      store.decide(owner, {
        commissionId: "recover",
        eventId: "revise",
        target: "proposal",
        proposalId: "p1",
        decision: { verdict: "revise", feedback: "Fix it" },
      });
      now += 60_001;
      expect(store.reconcileOverdue()).toBe(1);
      store.report({
        commissionId: "recover",
        eventId: "blocked",
        kind: "failure",
        data: { summary: "Blocked" },
      });
      now += 60_001;
      expect(store.reconcileOverdue()).toBe(0);
      store.report(proposal("p2"));
      store.decide(owner, {
        commissionId: "recover",
        eventId: "accept",
        target: "proposal",
        proposalId: "p2",
        decision: { verdict: "accept", feedback: "Done" },
      });
      now += 60_001;
      expect(store.read("recover").attention).toBeUndefined();
      expect(store.reconcileOverdue()).toBe(0);
    } finally {
      store.close();
    }
  });

  it("recovers questions, a lost delivery lease, answers and retries after close and reopen", () => {
    const file = path();
    let now = 0;
    let store = new CommissionStore(file, { now: () => now });
    store.open(owner, input);
    store.consult(question);
    const lost = claimAll(store, 10);
    store.close();
    store = new CommissionStore(file, { now: () => now });
    expect(claimAll(store)).toEqual([]);
    now = 11;
    const recovered = claimAll(store);
    expect(recovered.map((entry) => entry.eventId)).toEqual(lost.map((entry) => entry.eventId));
    store.decide(owner, answer);
    store.close();
    store = new CommissionStore(file, { now: () => now });
    expect(store.open(owner, input)).toEqual({ commissionId: "recover", status: "working" });
    expect(store.consult(question)).toMatchObject({ status: "answered", answer: "Option A" });
    expect(store.decide(owner, answer)).toEqual({ commissionId: "recover", status: "working" });
    for (const entry of recovered) store.acknowledgeOutbox(entry.seq, entry.leaseToken);
    expect(claimAll(store)).toEqual([]);
    store.close();
  });

  it("keeps event deduplication beyond eve's recent 1024 delivery keys", () => {
    const file = path();
    let store = new CommissionStore(file);
    store.open(owner, input);
    store.consult(question);
    store.decide(owner, answer);
    for (let i = 0; i < 1030; i++)
      store.report({
        commissionId: "recover",
        eventId: `checkpoint-${i}`,
        kind: "checkpoint",
        data: { summary: `${i}` },
      });
    store.close();
    store = new CommissionStore(file);
    expect(store.decide(owner, answer)).toMatchObject({ status: "working" });
    expect(() => store.decide(owner, { ...answer, decision: { answer: "changed" } })).toThrow(
      CommissionError,
    );
    store.close();
    const db = new Database(file, { readonly: true });
    expect(db.prepare("SELECT count(*) AS n FROM events").get()).toEqual({ n: 1034 });
    db.close();
  });

  it("refuses a ledger from another schema, naming it, and leaves it unchanged", () => {
    for (const version of [1, 3]) {
      const file = path();
      new CommissionStore(file).close();
      const other = new Database(file);
      other.pragma(`user_version = ${version}`);
      other.close();
      expect(() => new CommissionStore(file)).toThrow(`commissioning schema ${version}`);
      const after = new Database(file, { readonly: true });
      expect(after.pragma("user_version", { simple: true })).toBe(version);
      after.close();
    }
  });

  it("rolls the state, question, event and outbox back when the operation can't commit", () => {
    const file = path();
    const store = new CommissionStore(file);
    store.open(owner, input);
    const inspection = new Database(file);
    inspection.exec(
      "CREATE TRIGGER fail_operation BEFORE INSERT ON operations WHEN NEW.id='question:q' BEGIN SELECT RAISE(ABORT,'injected commit failure'); END;",
    );
    expect(() => store.consult(question)).toThrow("injected commit failure");
    expect(store.read("recover")).toMatchObject({ status: "working", questions: [] });
    expect(inspection.prepare("SELECT count(*) AS n FROM outbox").get()).toEqual({ n: 1 });
    inspection.exec("DROP TRIGGER fail_operation");
    inspection.close();
    expect(store.consult(question).status).toBe("pending");
    store.close();
    const reopened = new CommissionStore(file);
    expect(reopened.read("recover").events.map((event) => event.kind)).toEqual([
      "opened",
      "handoff",
      "question",
    ]);
    reopened.close();
  });
});
