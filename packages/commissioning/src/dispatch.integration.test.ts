import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouteHandlerArgs } from "eve/channels";
import type { SessionAuthContext } from "eve/context";
import { describe, expect, it, vi } from "vitest";
import type { CommissioningConfig } from "./config.js";
import { createDispatcher } from "./dispatch.js";
import { CommissionStore } from "./store.js";
import type { Commissioner, Conversation } from "./types.js";

type To = RouteHandlerArgs["to"];
const owner: Commissioner = { id: "ops-agent", conversation: { channel: "C1", thread: "1.0" } };
// The auth a delivery sends with: the agent's own principal in the captured conversation.
const deliveryAuth: SessionAuthContext = {
  authenticator: "test",
  principalId: "ops-agent-bot",
  principalType: "service",
  attributes: { channel: "C1", thread: "1.0" },
};
const channel = { name: "slack" } as unknown as Parameters<To>[0];
function config(overrides: Partial<CommissioningConfig> = {}): CommissioningConfig {
  return {
    dataDir: "/unused",
    namespace: "test",
    worker: { id: "test-worker", prepare: async () => ({}), handoff: async () => {} },
    authenticateWorker: () => true,
    commissioner: (auth) =>
      auth?.principalId === "ops-agent-bot"
        ? { id: "ops-agent", conversation: auth.attributes as Conversation }
        : null,
    deliver: (conversation) => ({
      channel,
      target: { ...conversation } as never,
      auth: deliveryAuth,
    }),
    ...overrides,
  };
}
/** eve's `to`, recording each send; `onSend` decides what a send does. */
function recordingTo(onSend: (commissionId: string) => void | Promise<void> = () => {}) {
  const sends: { target: unknown; message: string; options: unknown }[] = [];
  const to = ((_channel: unknown, target: unknown) => ({
    async send(message: string, options: unknown) {
      sends.push({ target, message, options });
      await onSend(/commission ([0-9a-z-]+)/.exec(message)?.[1] ?? "");
      return {};
    },
  })) as unknown as To;
  return { to, sends };
}
function open(store: CommissionStore, id: string) {
  store.open(owner, {
    commissionId: id,
    spec: { brief: "Work", acceptance: ["Done"] },
    workReference: { kind: "linear-issue", id: `ENG-${id}` },
    connectorId: "test-worker",
    binding: { issue: `ENG-${id}` },
  });
}
/** Opens commissions with their handoffs already confirmed, so a sweep only delivers notices. */
function openHandedOff(store: CommissionStore, ...ids: string[]) {
  for (const id of ids) open(store, id);
  for (const seq of store.pendingOutbox(1000)) {
    const entry = store.claimOutbox(seq);
    if (entry) store.acknowledgeOutbox(entry.seq, entry.leaseToken);
  }
}
function ask(store: CommissionStore, id: string) {
  store.consult({ commissionId: id, questionId: "q", question: { text: "Which?" } });
}

describe("dispatch", () => {
  it("hands the work off first, then tells the commissioner in the captured conversation", async () => {
    const store = new CommissionStore(":memory:");
    try {
      open(store, "one");
      const handoff = vi.fn(async () => {});
      const drain = createDispatcher(
        store,
        config({ worker: { id: "test-worker", prepare: vi.fn(), handoff } }),
      );
      const { to, sends } = recordingTo();
      await drain(to);
      expect(handoff).toHaveBeenCalledExactlyOnceWith({
        commissionId: "one",
        spec: { brief: "Work", acceptance: ["Done"] },
        binding: { issue: "ENG-one" },
      });
      expect(sends).toEqual([]);
      expect(store.read("one").handoff).toEqual({ status: "confirmed", lastFailure: null });
      ask(store, "one");
      const [question] = store.pendingOutbox();
      await drain(to);
      expect(sends).toHaveLength(1);
      expect(sends[0]).toMatchObject({
        target: { channel: "C1", thread: "1.0" },
        options: {
          auth: deliveryAuth,
          turnPolicy: "queue",
          idempotencyKey: `commissioning:one:${question}`,
        },
      });
      expect(sends[0].message).toContain("Which?");
      expect(store.pendingOutbox()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("keeps a notice pending when the delivery's auth doesn't resolve to the commission's owner", async () => {
    const store = new CommissionStore(":memory:");
    try {
      openHandedOff(store, "one");
      ask(store, "one");
      const elsewhere = { ...deliveryAuth, attributes: { channel: "C1", thread: "2.0" } };
      const { to, sends } = recordingTo();
      await createDispatcher(
        store,
        config({ deliver: () => ({ channel, target: {} as never, auth: elsewhere }) }),
      )(to);
      expect(sends).toEqual([]);
      expect(store.pendingOutbox()).toHaveLength(1);
      await createDispatcher(store, config())(to);
      expect(sends).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("keeps a failed or retargeted handoff pending with a fixed reason, and completes it later", async () => {
    for (const mode of ["changed-connector", "handoff-error"] as const) {
      const store = new CommissionStore(":memory:");
      try {
        open(store, "one");
        const handoff = vi.fn(async () => {
          throw new Error("provider text with a credential");
        });
        await createDispatcher(
          store,
          config({
            worker: {
              id: mode === "changed-connector" ? "other" : "test-worker",
              prepare: vi.fn(),
              handoff,
            },
          }),
        )(recordingTo().to);
        expect(handoff).toHaveBeenCalledTimes(mode === "handoff-error" ? 1 : 0);
        expect(store.read("one").handoff).toEqual({
          status: "pending",
          lastFailure: "handoff_failed",
        });
        expect(JSON.stringify(store.read("one"))).not.toContain("credential");
        await createDispatcher(store, config())(recordingTo().to);
        expect(store.read("one").handoff.status).toBe("confirmed");
      } finally {
        store.close();
      }
    }
  });

  it("gets past a failing prefix longer than one sweep, across dispatcher and store restarts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "commission-fairness-"));
    let store = new CommissionStore(join(dir, "db.sqlite"), { now: () => 1 });
    try {
      const ids = [...Array.from({ length: 101 }, (_, index) => `failed-${index}`), "healthy"];
      openHandedOff(store, ...ids);
      for (const id of ids) ask(store, id);
      const attempts: string[][] = [[], []];
      const sweep = (index: number) =>
        recordingTo((id) => {
          attempts[index].push(id);
          if (id !== "healthy") throw new Error("Persistent outage");
        }).to;
      await createDispatcher(store, config())(sweep(0));
      expect(new Set(attempts[0]).size).toBe(100);
      store.close();
      store = new CommissionStore(join(dir, "db.sqlite"), { now: () => 2 });
      await createDispatcher(store, config())(sweep(1));
      expect(attempts[1]).toContain("healthy");
      expect(new Set(attempts[1]).size).toBe(attempts[1].length);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tries a lone persistent failure once per sweep, and warns with fixed fields on each attempt", async () => {
    const store = new CommissionStore(":memory:");
    try {
      openHandedOff(store, "failed");
      ask(store, "failed");
      const failing = vi.fn(() => {
        throw new Error("offline with a credential");
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const drain = createDispatcher(store, config());
      await drain(recordingTo(failing).to);
      expect(failing).toHaveBeenCalledTimes(1);
      await drain(recordingTo(failing).to);
      expect(failing).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls).toEqual([
        ["[commissioning] delivery failed: commission=failed reason=delivery_failed attempt=1"],
        ["[commissioning] delivery failed: commission=failed reason=delivery_failed attempt=2"],
      ]);
    } finally {
      vi.restoreAllMocks();
      store.close();
    }
  });

  it("leases each entry just before its send, so six thirty-second sends all acknowledge", async () => {
    let now = 1;
    const store = new CommissionStore(":memory:", { now: () => now, overdueAfterMs: 1_000_000 });
    try {
      const ids = Array.from({ length: 6 }, (_, index) => `c${index}`);
      openHandedOff(store, ...ids);
      for (const id of ids) ask(store, id);
      const { to, sends } = recordingTo(() => {
        now += 30_000;
      });
      await createDispatcher(store, config())(to);
      expect(sends).toHaveLength(6);
      expect(store.pendingOutbox()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("recovers a send whose lease expired, under the same key, and doesn't let it starve a later commission", async () => {
    let now = 1;
    const store = new CommissionStore(":memory:", { now: () => now, overdueAfterMs: 1_000_000 });
    try {
      openHandedOff(store, "slow", "healthy");
      for (const id of ["slow", "healthy"]) ask(store, id);
      const sent: string[] = [];
      const drain = createDispatcher(store, config());
      const { to, sends } = recordingTo((id) => {
        sent.push(id);
        if (id === "slow") now += 120_001;
      });
      await drain(to);
      await drain(to);
      expect(sent).toEqual(["slow", "healthy", "slow"]);
      // eve takes a repeated key once, so the redelivery repeats the first send's key.
      const keys = sends.map(
        (send) => (send.options as { idempotencyKey?: string }).idempotencyKey,
      );
      expect(keys[2]).toBe(keys[0]);
      expect(store.pendingOutbox()).toHaveLength(1);
      await drain(recordingTo().to);
      expect(store.pendingOutbox()).toEqual([]);
    } finally {
      store.close();
    }
  });
});
