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
  it("retains rebind receipts, immutable provenance and actual operator audit across restart and competing CAS", () => {
    const file = path();
    let store = new CommissionStore(file);
    const source = { channel: "native", workId: "private-work" };
    const context = {
      originSessionId: "original-session",
      messages: [{ role: "user" as const, content: "Original snapshot" }],
      source,
      initiator: {
        principalId: "original-human",
        authenticator: "native-auth",
        principalType: "user",
      },
    };
    const operator: Caller = { verified: true, principalId: "actual-recovery-operator" };
    const recovery = {
      commissionId: "recover",
      eventId: "rebind-first",
      expectedActiveSessionId: "original-session",
      activeSessionId: "replacement-session",
      source,
    };
    store.open(owner, input, worker, context);
    store.rebindSession(owner, recovery, operator);
    store.close();
    store = new CommissionStore(file);
    expect(store.rebindSession(owner, recovery, operator)).toEqual({
      commissionId: "recover",
      activeSessionId: "replacement-session",
    });
    const competing = new CommissionStore(file);
    competing.rebindSession(
      owner,
      {
        ...recovery,
        eventId: "rebind-second",
        expectedActiveSessionId: "replacement-session",
        activeSessionId: "latest-session",
      },
      operator,
    );
    expect(() =>
      store.rebindSession(
        owner,
        {
          ...recovery,
          eventId: "stale-race",
          expectedActiveSessionId: "replacement-session",
          activeSessionId: "stale-session",
        },
        operator,
      ),
    ).toThrow("Commission session changed");
    expect(store.context("recover")).toEqual({ ...context, activeSessionId: "latest-session" });
    expect(store.read(worker, "recover").status).toBe("working");
    competing.close();
    store.close();
    const inspection = new Database(file, { readonly: true });
    const events = inspection
      .prepare("SELECT actor,payload FROM events WHERE kind='session_rebound' ORDER BY seq")
      .all() as { actor: string; payload: string }[];
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.actor === operator.principalId)).toBe(true);
    expect(JSON.parse(events[0].payload)).toEqual({
      priorSessionId: "original-session",
      activeSessionId: "replacement-session",
      requestedByPrincipalId: operator.principalId,
    });
    expect(inspection.prepare("SELECT count(*) n FROM outbox").get()).toEqual({ n: 0 });
    inspection.close();
  });

  it("rolls back the active pointer when an audited rebind cannot commit", () => {
    const file = path();
    const store = new CommissionStore(file);
    const context = {
      originSessionId: "original",
      messages: [{ role: "user" as const, content: "Snapshot" }],
      source: { id: "fixed-source" },
    };
    store.open(owner, input, worker, context);
    const inspection = new Database(file);
    inspection.exec(
      "CREATE TRIGGER reject_rebind BEFORE INSERT ON events WHEN NEW.kind='session_rebound' BEGIN SELECT RAISE(ABORT,'injected audit failure'); END;",
    );
    const recovery = {
      commissionId: "recover",
      eventId: "recovery",
      expectedActiveSessionId: "original",
      activeSessionId: "replacement",
      source: context.source,
    };
    expect(() => store.rebindSession(owner, recovery, owner)).toThrow("injected audit failure");
    expect(store.context("recover")).toEqual(context);
    expect(
      inspection.prepare("SELECT count(*) n FROM operations WHERE id='event:recovery'").get(),
    ).toEqual({ n: 0 });
    inspection.exec("DROP TRIGGER reject_rebind");
    inspection.close();
    expect(store.rebindSession(owner, recovery, owner)).toEqual({
      commissionId: "recover",
      activeSessionId: "replacement",
    });
    store.close();
  });
  it("recovers an activation committed before any external call and never duplicates its intent", () => {
    const file = path();
    let store = new CommissionStore(file);
    const context = {
      originSessionId: "original",
      messages: [{ role: "user" as const, content: "Private original snapshot" }],
      source: { workIssueId: "fixed-public-work-record" },
    };
    const receipt = store.open(owner, input, worker, context, { requestWorkerActivation: true });
    store.close(); // Lost caller receipt; no external activation callback or outbox claim has happened.
    store = new CommissionStore(file);
    expect(store.open(owner, input, worker, context, { requestWorkerActivation: true })).toEqual(
      receipt,
    );
    expect(store.context("recover")).toEqual(context);
    const pending = store.claimOutbox({ consumerId: "restarted-host" });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      recipient: "owner",
      kind: "worker_activation_requested",
      payload: { commissionId: "recover" },
    });
    store.acknowledgeOutbox(pending[0].seq, pending[0].leaseToken);
    store.close();
    store = new CommissionStore(file);
    expect(store.open(owner, input, worker, context, { requestWorkerActivation: true })).toEqual(
      receipt,
    );
    expect(store.claimOutbox({ consumerId: "again" })).toEqual([]);
    expect(store.read(worker, "recover").events.map((event) => event.kind)).toEqual([
      "opened",
      "worker_activation_requested",
    ]);
    store.close();
    const inspection = new Database(file, { readonly: true });
    expect(inspection.prepare("SELECT count(*) n FROM operations").get()).toEqual({ n: 1 });
    expect(inspection.prepare("SELECT count(*) n FROM outbox").get()).toEqual({ n: 1 });
    inspection.close();
  });

  it("rolls the entire open back if either activation audit or outbox insertion fails", () => {
    for (const table of ["events", "outbox"]) {
      const file = path();
      const store = new CommissionStore(file);
      const inspection = new Database(file);
      inspection.exec(
        `CREATE TRIGGER reject_activation BEFORE INSERT ON ${table} WHEN NEW.kind='worker_activation_requested' BEGIN SELECT RAISE(ABORT,'injected activation failure'); END;`,
      );
      const context = {
        originSessionId: "original",
        messages: [{ role: "user" as const, content: "Private snapshot" }],
      };
      expect(() =>
        store.open(owner, input, worker, context, { requestWorkerActivation: true }),
      ).toThrow("injected activation failure");
      for (const target of ["commissions", "contexts", "events", "operations", "outbox"])
        expect(inspection.prepare(`SELECT count(*) n FROM ${target}`).get()).toEqual({ n: 0 });
      expect(store.context("recover")).toBeUndefined();
      inspection.exec("DROP TRIGGER reject_activation");
      expect(store.open(owner, input, worker, context, { requestWorkerActivation: true })).toEqual({
        commissionId: "recover",
        status: "working",
      });
      expect(inspection.prepare("SELECT count(*) n FROM outbox").get()).toEqual({ n: 1 });
      inspection.close();
      store.close();
    }
  });

  it("preserves the legacy open fingerprint and default/false replay after reopening", () => {
    const file = path();
    let store = new CommissionStore(file);
    const receipt = store.open(owner, input, worker);
    store.close();
    const inspection = new Database(file, { readonly: true });
    // Historical canonical fingerprint before the activation option existed (no context, no option field).
    expect(inspection.prepare("SELECT hash FROM operations WHERE id='open'").get()).toEqual({
      hash: "bf77f9589236541e4c2df472801a3d051611363ed4b3c026eb637549c87b5e20",
    });
    expect(inspection.prepare("SELECT count(*) n FROM outbox").get()).toEqual({ n: 0 });
    inspection.close();
    store = new CommissionStore(file);
    expect(store.open(owner, input, worker)).toEqual(receipt);
    expect(store.open(owner, input, worker, undefined, { requestWorkerActivation: false })).toEqual(
      receipt,
    );
    expect(() =>
      store.open(owner, input, worker, undefined, { requestWorkerActivation: true }),
    ).toThrow("Event ID was already used with different input");
    store.close();
  });
});
