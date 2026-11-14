import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { staleSandboxState } from "./reap.js";
import { recordSandboxSession } from "./session-record.js";

// microsandbox's records of VMs, as `Sandbox.list()` returns them.
const msb = vi.hoisted(() => ({
  sandboxes: [] as { name: string; status: string; createdAt: Date; updatedAt: Date | null }[],
  destroyed: [] as string[],
}));

vi.mock("microsandbox", () => {
  class SandboxNotFoundError extends Error {}
  return {
    SandboxNotFoundError,
    Sandbox: {
      list: async () => ({ sandboxes: msb.sandboxes.slice(0, 2), nextCursor: "page-2" }),
      listWith: async () => ({ sandboxes: msb.sandboxes.slice(2) }),
      async get(name: string) {
        const record = msb.sandboxes.find((sandbox) => sandbox.name === name);
        if (record === undefined) throw new SandboxNotFoundError(name);
        return { ...record, destroy: async () => void msb.destroyed.push(name) };
      },
    },
  };
});

const DAY = 24 * 60 * 60_000;
const NOW = Date.UTC(2026, 10, 1);
const ago = (days: number) => new Date(NOW - days * DAY);
const vm = (name: string, status: string, lastUsedDaysAgo: number) => ({
  name,
  status,
  createdAt: ago(lastUsedDaysAgo + 1),
  updatedAt: ago(lastUsedDaysAgo),
});

// The provider's records of each VM's session live under MSB_HOME; every test gets an empty one.
let msbHome: string;

beforeEach(() => {
  msb.sandboxes = [];
  msb.destroyed = [];
  msbHome = mkdtempSync(join(tmpdir(), "eve-plus-msb-"));
  vi.stubEnv("MSB_HOME", msbHome);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(msbHome, { recursive: true, force: true });
});

const find = () => staleSandboxState({ unusedForMs: 7 * DAY, now: NOW });

describe("staleSandboxState", () => {
  it("finds a stopped VM unused past the cutoff, across pages, and removes it", async () => {
    msb.sandboxes = [
      vm("eve-plus-sbx-recent", "stopped", 1),
      vm("eve-plus-sbx-running", "running", 30),
      vm("eve-plus-sbx-stranded", "stopped", 30),
    ];
    const stale = await find();
    expect(stale.map((item) => item.name)).toEqual(["eve-plus-sbx-stranded"]);
    await stale[0]?.remove();
    expect(msb.destroyed).toEqual(["eve-plus-sbx-stranded"]);
  });

  it("leaves VMs that aren't this provider's", async () => {
    msb.sandboxes = [vm("someone-elses", "stopped", 30)];
    expect(await find()).toEqual([]);
  });

  it("doesn't remove a VM something started after it was found", async () => {
    msb.sandboxes = [vm("eve-plus-sbx-woken", "stopped", 30)];
    const [item] = await find();
    msb.sandboxes = [vm("eve-plus-sbx-woken", "running", 0)];
    await item?.remove();
    expect(msb.destroyed).toEqual([]);
  });

  describe("with isSessionLive", () => {
    const names = (stale: { name: string }[]) => stale.map((item) => item.name);

    it("never finds a live session's VM, however long it has gone unused", async () => {
      msb.sandboxes = [vm("eve-plus-sbx-quiet", "stopped", 365)];
      await recordSandboxSession("eve-plus-sbx-quiet", "session-quiet");
      const stale = await staleSandboxState({
        unusedForMs: 7 * DAY,
        now: NOW,
        isSessionLive: async (sessionId) => sessionId === "session-quiet",
      });
      expect(stale).toEqual([]);
    });

    it("finds a VM whose session isn't live once it is unused past the cutoff, and not before", async () => {
      msb.sandboxes = [
        vm("eve-plus-sbx-ended", "stopped", 30),
        vm("eve-plus-sbx-new", "stopped", 1),
      ];
      await recordSandboxSession("eve-plus-sbx-ended", "session-ended");
      await recordSandboxSession("eve-plus-sbx-new", "session-new");
      const stale = await staleSandboxState({
        unusedForMs: 7 * DAY,
        now: NOW,
        isSessionLive: () => false,
      });
      expect(names(stale)).toEqual(["eve-plus-sbx-ended"]);
    });

    it("judges a VM with no recorded session by its last use alone", async () => {
      msb.sandboxes = [
        vm("eve-plus-sbx-unrecorded", "stopped", 30),
        vm("eve-plus-sbx-unrecorded-recent", "stopped", 1),
      ];
      const stale = await staleSandboxState({
        unusedForMs: 7 * DAY,
        now: NOW,
        isSessionLive: () => true,
      });
      expect(names(stale)).toEqual(["eve-plus-sbx-unrecorded"]);
    });

    it("fails, finding nothing to remove, when isSessionLive fails", async () => {
      msb.sandboxes = [vm("eve-plus-sbx-quiet", "stopped", 30)];
      await recordSandboxSession("eve-plus-sbx-quiet", "session-quiet");
      await expect(
        staleSandboxState({
          unusedForMs: 7 * DAY,
          now: NOW,
          isSessionLive: async () => {
            throw new Error("session store unreachable");
          },
        }),
      ).rejects.toThrow("session store unreachable");
    });

    it("removes the VM's record of its session with the VM", async () => {
      msb.sandboxes = [vm("eve-plus-sbx-ended", "stopped", 30)];
      await recordSandboxSession("eve-plus-sbx-ended", "session-ended");
      const [item] = await find();
      await item?.remove();
      // A VM later found under the same name has no session to protect it.
      const stale = await staleSandboxState({
        unusedForMs: 7 * DAY,
        now: NOW,
        isSessionLive: () => true,
      });
      expect(names(stale)).toEqual(["eve-plus-sbx-ended"]);
    });

    it("keeps the record of a VM that remove() left alone because something started it", async () => {
      msb.sandboxes = [vm("eve-plus-sbx-woken", "stopped", 30)];
      await recordSandboxSession("eve-plus-sbx-woken", "session-woken");
      const [item] = await find();
      msb.sandboxes = [vm("eve-plus-sbx-woken", "running", 0)];
      await item?.remove();
      msb.sandboxes = [vm("eve-plus-sbx-woken", "stopped", 30)];
      const stale = await staleSandboxState({
        unusedForMs: 7 * DAY,
        now: NOW,
        isSessionLive: (sessionId) => sessionId === "session-woken",
      });
      expect(stale).toEqual([]);
    });
  });

  it("without isSessionLive, judges a VM by its last use alone even when its session is recorded", async () => {
    msb.sandboxes = [vm("eve-plus-sbx-quiet", "stopped", 30), vm("eve-plus-sbx-new", "stopped", 1)];
    await recordSandboxSession("eve-plus-sbx-quiet", "session-quiet");
    await recordSandboxSession("eve-plus-sbx-new", "session-new");
    expect((await find()).map((item) => item.name)).toEqual(["eve-plus-sbx-quiet"]);
  });
});
