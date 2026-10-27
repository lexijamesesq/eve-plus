import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { CommissioningConfig } from "./config.js";
import { createDispatcher } from "./dispatch.js";
import { CommissionStore } from "./store.js";

const owner = { verified: true as const, principalId: "owner" };
const worker = { verified: true as const, principalId: "worker" };
const auth = { authenticator: "test", principalId: "owner", principalType: "user", attributes: {} };
const config: CommissioningConfig = {
  dataDir: "/tmp/unused",
  namespace: "test",
  workerPrincipalId: "worker",
  authenticateWorker: () => worker,
  resolveSessionPrincipal: (value) => (value?.principalId === "owner" ? owner : null),
  resolveDeliveryAuth: () => auth,
};
function open(store: CommissionStore, id: string) {
  store.open(owner, { commissionId: id, spec: { brief: "Work", acceptance: ["Done"] } }, worker);
}

describe("dispatch receipts and long native sends", () => {
  it("takes a fresh lease per send, so six thirty-second native sends all acknowledge", async () => {
    let now = 1;
    const store = new CommissionStore(":memory:", { now: () => now, overdueAfterMs: 1000000 });
    try {
      for (let index = 0; index < 6; index++) {
        open(store, String(index));
        store.consult(worker, {
          commissionId: String(index),
          questionId: "q",
          question: { text: "Which?" },
        });
      }
      let count = 0;
      await createDispatcher(
        store,
        config,
      )(async () => {
        now += 30000;
        count++;
      });
      expect(count).toBe(6);
      for (let index = 0; index < 6; index++)
        expect(store.read(owner, String(index)).notification).toMatchObject({
          pending: 0,
          attemptCount: 1,
          failureClass: null,
        });
    } finally {
      store.close();
    }
  });
  it("recovers an expired individual receipt on a later sweep", async () => {
    let now = 1;
    const store = new CommissionStore(":memory:", { now: () => now, overdueAfterMs: 1000000 });
    try {
      open(store, "one");
      store.consult(worker, { commissionId: "one", questionId: "q", question: { text: "Which?" } });
      const drain = createDispatcher(store, config);
      await expect(
        drain(async () => {
          now += 120001;
        }),
      ).resolves.toBeUndefined();
      expect(store.read(owner, "one").notification?.pending).toBe(1);
      await drain(async () => {});
      expect(store.read(owner, "one").notification?.pending).toBe(0);
    } finally {
      store.close();
    }
  });
  it("does not let an always-expired receipt starve a healthy later commission", async () => {
    let now = 1;
    const store = new CommissionStore(":memory:", { now: () => now, overdueAfterMs: 1000000 });
    try {
      for (const id of ["slow", "healthy"]) {
        open(store, id);
        store.consult(worker, { commissionId: id, questionId: "q", question: { text: "Which?" } });
      }
      const sent: string[] = [];
      const drain = createDispatcher(store, config);
      const deliver = async ({ entry }: import("./dispatch.js").OwnerDelivery) => {
        sent.push(entry.commissionId);
        if (entry.commissionId === "slow") now += 120001;
      };
      await drain(deliver);
      await drain(deliver);
      expect(sent).toEqual(["slow", "healthy", "slow"]);
      expect(store.read(owner, "healthy").notification?.pending).toBe(0);
      expect(store.read(owner, "slow").notification?.pending).toBe(1);
    } finally {
      store.close();
    }
  });
  it("persists safe failed-delivery diagnostics over restart and omits them from worker views", async () => {
    const dir = mkdtempSync(join(tmpdir(), "commission-receipt-"));
    let store = new CommissionStore(join(dir, "db.sqlite"), { now: () => 42 });
    try {
      open(store, "one");
      store.consult(worker, { commissionId: "one", questionId: "q", question: { text: "Which?" } });
      await createDispatcher(
        store,
        config,
      )(async () => {
        throw new Error("credential-must-never-be-stored");
      });
      store.close();
      store = new CommissionStore(join(dir, "db.sqlite"), { now: () => 43 });
      expect(store.read(owner, "one").notification).toEqual({
        pending: 1,
        attemptCount: 1,
        lastAttemptAt: 42,
        failureClass: "dispatch_failed",
      });
      expect(store.read(worker, "one").notification).toBeUndefined();
      expect(JSON.stringify(store.read(owner, "one"))).not.toContain(
        "credential-must-never-be-stored",
      );
      await createDispatcher(store, config)(async () => {});
      expect(store.read(owner, "one").notification).toEqual({
        pending: 0,
        attemptCount: 2,
        lastAttemptAt: 43,
        failureClass: null,
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("keeps the current proposal independent of a paginated event history", () => {
    const store = new CommissionStore(":memory:");
    try {
      open(store, "one");
      for (let index = 0; index < 105; index++)
        store.report(worker, {
          commissionId: "one",
          eventId: `checkpoint-${index}`,
          kind: "checkpoint",
          data: { summary: "Working" },
        });
      const artifact = {
        repository: "https://example.test/repo",
        commit: "a".repeat(40),
        pullRequest: "https://example.test/repo/pull/1",
      };
      store.report(worker, {
        commissionId: "one",
        eventId: "proposal",
        kind: "proposal",
        data: { summary: "Ready", artifact },
      });
      const view = store.read(owner, "one");
      expect(view.events).toHaveLength(100);
      expect(view.events.some((event) => event.kind === "proposal")).toBe(false);
      expect(view.currentProposal).toEqual({ proposalId: "proposal", summary: "Ready", artifact });
    } finally {
      store.close();
    }
  });
  it("migrates v1 outbox diagnostics without losing prior ledger state", () => {
    const dir = mkdtempSync(join(tmpdir(), "commission-migration-"));
    const path = join(dir, "db.sqlite");
    let store = new CommissionStore(path);
    try {
      open(store, "one");
      store.consult(worker, { commissionId: "one", questionId: "q", question: { text: "Which?" } });
      store.close();
      const db = new Database(path);
      db.exec(
        "ALTER TABLE outbox DROP COLUMN attempt_count; ALTER TABLE outbox DROP COLUMN last_attempt_at; ALTER TABLE outbox DROP COLUMN failure_class; PRAGMA user_version=1;",
      );
      db.close();
      store = new CommissionStore(path);
      expect(store.read(owner, "one").questions).toHaveLength(1);
      expect(store.read(owner, "one").notification).toEqual({
        pending: 1,
        attemptCount: 0,
        lastAttemptAt: null,
        failureClass: null,
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
