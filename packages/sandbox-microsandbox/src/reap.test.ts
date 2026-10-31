import { beforeEach, describe, expect, it, vi } from "vitest";
import { staleSandboxState } from "./reap.js";

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

beforeEach(() => {
  msb.sandboxes = [];
  msb.destroyed = [];
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
});
