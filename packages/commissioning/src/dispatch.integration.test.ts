import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
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
  it("progresses beyond a failed prefix larger than one sweep across dispatcher and store restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "commission-fairness-"));
    let store = new CommissionStore(join(dir, "db.sqlite"), { now: () => 1 });
    const attempts: string[][] = [[], []];
    try {
      for (const id of [
        ...Array.from({ length: 101 }, (_, index) => `failed-${index}`),
        "healthy",
      ]) {
        open(store, id);
        store.consult(worker, { commissionId: id, questionId: "q", question: { text: "Which?" } });
      }
      const deliver =
        (sweep: number) =>
        async ({ entry }: import("./dispatch.js").OwnerDelivery) => {
          attempts[sweep].push(entry.commissionId);
          if (entry.commissionId !== "healthy") throw new Error("Persistent synthetic outage");
        };
      await createDispatcher(store, config)(deliver(0));
      expect(attempts[0]).toHaveLength(100);
      expect(new Set(attempts[0]).size).toBe(100);
      store.close();
      store = new CommissionStore(join(dir, "db.sqlite"), { now: () => 2 });
      await createDispatcher(store, config)(deliver(1));
      expect(attempts[1]).toContain("healthy");
      expect(new Set(attempts[1]).size).toBe(attempts[1].length);
      expect(attempts[1].length).toBeLessThanOrEqual(100);
      expect(store.read(owner, "healthy").notification?.pending).toBe(0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("attempts a lone persistent failure only once per bounded sweep", async () => {
    const store = new CommissionStore(":memory:");
    try {
      open(store, "failed");
      store.consult(worker, {
        commissionId: "failed",
        questionId: "q",
        question: { text: "Which?" },
      });
      const deliver = vi.fn(async () => {
        throw new Error("offline");
      });
      const drain = createDispatcher(store, config);
      await drain(deliver);
      expect(deliver).toHaveBeenCalledTimes(1);
      await drain(deliver);
      expect(deliver).toHaveBeenCalledTimes(2);
    } finally {
      store.close();
    }
  });
  it("preserves explicitly requested legacy activation delivery when no connector was bound", async () => {
    const store = new CommissionStore(":memory:");
    try {
      store.open(
        owner,
        { commissionId: "legacy", spec: { brief: "Work", acceptance: ["Done"] } },
        worker,
        undefined,
        { requestWorkerActivation: true },
      );
      const deliver = vi.fn(async (_delivery: import("./dispatch.js").OwnerDelivery) => {});
      await createDispatcher(store, config)(deliver);
      expect(deliver).toHaveBeenCalledOnce();
      expect(deliver.mock.calls[0]?.[0].entry.kind).toBe("worker_activation_requested");
      expect(store.workerBinding("legacy")).toBeUndefined();
      expect(store.read(owner, "legacy").notification?.pending).toBe(0);
    } finally {
      store.close();
    }
  });
  it("hands off persisted worker-only data before owner authentication and leaves ordinary delivery unchanged", async () => {
    const store = new CommissionStore(":memory:");
    try {
      const reference = { kind: "test-issue", id: "WORK-1" };
      store.open(
        owner,
        {
          commissionId: "bound",
          workReference: reference,
          spec: { brief: "Work", acceptance: ["Done"], privateGuidance: "private-guidance" },
        },
        worker,
        {
          originSessionId: "private-session",
          messages: [{ role: "user", content: "private-history" }],
          source: { issue: "private-source" },
          initiator: {
            principalId: "private-initiator",
            authenticator: "test",
            principalType: "user",
          },
        },
        {
          workerBinding: {
            commissionId: "bound",
            connectorId: "test",
            reference,
            binding: { target: "fixed-target" },
          },
        },
      );
      const handoff = vi.fn(async () => {});
      const resolveDeliveryAuth = vi.fn(() => {
        throw new Error("owner-auth-is-unavailable");
      });
      const deliver = vi.fn(async () => {});
      const drain = createDispatcher(store, {
        ...config,
        resolveDeliveryAuth,
        worker: { id: "test", prepare: vi.fn(), handoff },
      });
      await drain(deliver);
      expect(handoff).toHaveBeenCalledExactlyOnceWith({
        commissionId: "bound",
        spec: { brief: "Work", acceptance: ["Done"] },
        binding: { target: "fixed-target" },
      });
      expect(resolveDeliveryAuth).not.toHaveBeenCalled();
      expect(deliver).not.toHaveBeenCalled();
      expect(store.read(owner, "bound").notification?.pending).toBe(0);
      const packet = JSON.stringify(handoff.mock.calls);
      for (const value of [
        "private-guidance",
        "private-session",
        "private-history",
        "private-source",
        "private-initiator",
      ])
        expect(packet).not.toContain(value);
      store.consult(worker, {
        commissionId: "bound",
        questionId: "q",
        question: { text: "Which?" },
      });
      await drain(deliver);
      expect(resolveDeliveryAuth).toHaveBeenCalledExactlyOnceWith("owner");
      expect(store.read(owner, "bound").notification?.failureClass).toBe("identity_unavailable");
      const delivered = vi.fn(async (_delivery: import("./dispatch.js").OwnerDelivery) => {});
      await createDispatcher(store, config)(delivered);
      expect(delivered).toHaveBeenCalledOnce();
      expect(delivered.mock.calls[0]?.[0]).toMatchObject({
        entry: { kind: "question" },
        context: { originSessionId: "private-session" },
      });
    } finally {
      store.close();
    }
  });

  it("keeps missing or changed activation bindings pending with fixed safe failure classes", async () => {
    for (const mode of ["no-config", "no-binding", "mismatch", "handoff-error"] as const) {
      const store = new CommissionStore(":memory:");
      try {
        const reference = { kind: "test-issue", id: "WORK-1" };
        const bound = mode !== "no-binding";
        store.open(
          owner,
          {
            commissionId: "one",
            spec: { brief: "Work", acceptance: ["Done"] },
            ...(bound ? { workReference: reference } : {}),
          },
          worker,
          undefined,
          bound
            ? {
                workerBinding: {
                  commissionId: "one",
                  connectorId: "original",
                  reference,
                  binding: { target: "fixed" },
                },
              }
            : { requestWorkerActivation: true },
        );
        const handoff = vi.fn(async () => {
          throw new Error("credential-and-provider-text-must-stay-private");
        });
        const deliver = vi.fn(async () => {});
        const resolveDeliveryAuth = vi.fn(() => auth);
        await createDispatcher(store, {
          ...config,
          resolveDeliveryAuth,
          ...(mode === "no-config"
            ? {}
            : {
                worker: {
                  id: mode === "mismatch" ? "changed" : "original",
                  prepare: vi.fn(),
                  handoff,
                },
              }),
        })(deliver);
        expect(deliver).not.toHaveBeenCalled();
        expect(resolveDeliveryAuth).not.toHaveBeenCalled();
        expect(handoff).toHaveBeenCalledTimes(mode === "handoff-error" ? 1 : 0);
        expect(store.read(owner, "one").notification).toMatchObject({
          pending: 1,
          failureClass:
            mode === "no-config"
              ? "worker_unavailable"
              : mode === "handoff-error"
                ? "worker_handoff_failed"
                : "worker_binding_mismatch",
        });
        expect(JSON.stringify(store.read(owner, "one"))).not.toContain(
          "credential-and-provider-text",
        );
        if (bound) {
          const recovered = vi.fn(async () => {});
          await createDispatcher(store, {
            ...config,
            worker: { id: "original", prepare: vi.fn(), handoff: recovered },
          })(deliver);
          expect(recovered).toHaveBeenCalledOnce();
          expect(store.read(owner, "one").notification?.pending).toBe(0);
        }
      } finally {
        store.close();
      }
    }
  });
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
        "DROP TABLE worker_bindings; ALTER TABLE outbox DROP COLUMN attempt_count; ALTER TABLE outbox DROP COLUMN last_attempt_at; ALTER TABLE outbox DROP COLUMN failure_class; PRAGMA user_version=1;",
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
