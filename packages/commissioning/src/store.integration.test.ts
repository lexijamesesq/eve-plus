import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { CommissionError, CommissionStore } from "./store.js";
import type { Caller, DecisionInput } from "./types.js";

const owner: Caller = { principalId: "owner", verified: true };
const worker: Caller = { principalId: "worker", verified: true };
const input = {
  commissionId: "recover",
  spec: { brief: "Build", acceptance: ["Works"], privateGuidance: "Private" },
};
const question = { commissionId: "recover", questionId: "q", question: { text: "Which option?" } };
const answer: DecisionInput = {
  commissionId: "recover",
  eventId: "answer",
  target: "question",
  questionId: "q",
  decision: { answer: "Option A" },
};
const paths: string[] = [];
function path(): string {
  const dir = mkdtempSync(join(tmpdir(), "commissioning-"));
  paths.push(dir);
  return join(dir, "nested", "ledger.sqlite");
}
afterEach(() => {
  for (const dir of paths.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("on-disk commissioning recovery", () => {
  it("recovers committed questions, delivery leases, answers and caller retries after close/reopen", () => {
    const file = path();
    let now = 0;
    let store = new CommissionStore(file, { now: () => now });
    const context = {
      originSessionId: "session",
      messages: [{ role: "user" as const, content: "Original private context" }],
    };
    store.open(owner, input, worker, context);
    store.consult(worker, question);
    const lostReceipt = store.claimOutbox({ consumerId: "before-crash", leaseMs: 10 })[0];
    store.close();
    store = new CommissionStore(file, { now: () => now });
    expect(store.claimOutbox({ consumerId: "restart" })).toEqual([]);
    now = 11;
    const recovered = store.claimOutbox({ consumerId: "restart" })[0];
    expect(recovered.seq).toBe(lostReceipt.seq);
    expect(recovered.eventId).toBe(lostReceipt.eventId);
    store.decide(owner, answer);
    store.close();
    store = new CommissionStore(file, { now: () => now });
    expect(store.context("recover")).toEqual(context);
    expect(store.open(owner, input, worker, context)).toMatchObject({ status: "working" });
    expect(store.consult(worker, question)).toMatchObject({
      status: "answered",
      answer: { answer: "Option A" },
    });
    expect(store.decide(owner, answer)).toMatchObject({ status: "working" });
    store.acknowledgeOutbox(recovered.seq, recovered.leaseToken);
    expect(store.read(owner, "recover").events.map((event) => event.kind)).toEqual([
      "opened",
      "question",
      "decision",
    ]);
    expect(store.claimOutbox({ consumerId: "again" })).toEqual([]);
    store.close();
  });

  it("retains overdue attention deduplication after reopening the database", () => {
    const file = path();
    let now = 0;
    let store = new CommissionStore(file, { now: () => now });
    store.open(owner, input, worker);
    now = 60_001;
    expect(store.reconcileOverdue()).toBe(1);
    store.close();
    store = new CommissionStore(file, { now: () => now });
    expect(store.reconcileOverdue()).toBe(0);
    expect(store.claimOutbox({ consumerId: "restart" })).toMatchObject([
      { kind: "overdue_checkpoint" },
    ]);
    expect(store.read(worker, "recover").status).toBe("working");
    store.close();
  });

  it("keeps event deduplication beyond eve's recent 1024 delivery keys", () => {
    const file = path();
    let store = new CommissionStore(file);
    store.open(owner, input, worker);
    store.consult(worker, question);
    store.decide(owner, answer);
    for (let i = 0; i < 1030; i++)
      store.report(worker, {
        commissionId: "recover",
        eventId: `checkpoint-${i}`,
        kind: "checkpoint",
        data: { summary: `Progress ${i}` },
      });
    store.close();
    store = new CommissionStore(file);
    expect(store.decide(owner, answer)).toMatchObject({ status: "working" });
    expect(store.consult(worker, question).status).toBe("answered");
    expect(() => store.decide(owner, { ...answer, decision: { answer: "changed" } })).toThrow(
      CommissionError,
    );
    store.close();
    const db = new Database(file, { readonly: true });
    expect(db.prepare("SELECT count(*) AS n FROM events").get()).toEqual({ n: 1033 });
    expect(db.prepare("SELECT count(*) AS n FROM outbox").get()).toEqual({ n: 1 });
    db.close();
  });

  it("rolls state, questions, events and outbox back when operation commit fails", () => {
    const file = path();
    const store = new CommissionStore(file);
    store.open(owner, input, worker);
    const inspection = new Database(file);
    inspection.exec(
      "CREATE TRIGGER fail_operation BEFORE INSERT ON operations WHEN NEW.id='question:q' BEGIN SELECT RAISE(ABORT,'injected commit failure'); END;",
    );
    expect(() => store.consult(worker, question)).toThrow("injected commit failure");
    expect(store.read(owner, "recover")).toMatchObject({ status: "working", questions: [] });
    expect(inspection.prepare("SELECT count(*) AS n FROM outbox").get()).toEqual({ n: 0 });
    expect(inspection.prepare("SELECT count(*) AS n FROM events").get()).toEqual({ n: 1 });
    inspection.exec("DROP TRIGGER fail_operation");
    inspection.close();
    expect(store.consult(worker, question).status).toBe("pending");
    store.close();
    const reopened = new CommissionStore(file);
    expect(reopened.read(owner, "recover").events.map((event) => event.kind)).toEqual([
      "opened",
      "question",
    ]);
    reopened.close();
  });

  it("supports competing local handles without double claiming or duplicate canonical effects", () => {
    const file = path();
    const first = new CommissionStore(file);
    const second = new CommissionStore(file);
    first.open(owner, input, worker);
    second.consult(worker, question);
    first.consult(worker, question);
    const claimed = first.claimOutbox({ consumerId: "first" });
    expect(claimed).toHaveLength(1);
    expect(second.claimOutbox({ consumerId: "second" })).toEqual([]);
    second.decide(owner, answer);
    first.decide(owner, answer);
    expect(first.read(owner, "recover").questions).toHaveLength(1);
    expect(first.read(owner, "recover").events).toHaveLength(3);
    first.close();
    second.close();
  });

  it("refuses unsupported future schemas and unversioned data without modifying them", () => {
    for (const version of [3, 999]) {
      const file = path();
      const initial = new CommissionStore(file);
      initial.close();
      const db = new Database(file);
      db.pragma(`user_version=${version}`);
      db.close();
      try {
        new CommissionStore(file);
        throw new Error("Expected schema refusal");
      } catch (error) {
        expect(error).toBeInstanceOf(CommissionError);
        expect((error as CommissionError).code).toBe("unsupported_schema");
      }
      const check = new Database(file);
      expect(check.pragma("user_version", { simple: true })).toBe(version);
      check.close();
    }
    const file = join(paths[0], "unknown.sqlite");
    const db = new Database(file);
    db.exec("CREATE TABLE important(value TEXT); INSERT INTO important VALUES('keep');");
    db.close();
    expect(() => new CommissionStore(file)).toThrow("Unversioned nonempty database");
    const check = new Database(file);
    expect(check.prepare("SELECT value FROM important").get()).toEqual({ value: "keep" });
    check.close();
  });
});
