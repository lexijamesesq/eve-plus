import { mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { staleSandboxState } from "./reap.js";

// microsandbox's records of VMs and snapshots, as `Sandbox.list()` and `Snapshot.list()` return them.
const msb = vi.hoisted(() => ({
  sandboxes: [] as { name: string; status: string; createdAt: Date; updatedAt: Date | null }[],
  snapshots: [] as { name: string | null; digest: string; createdAt: Date }[],
  destroyed: [] as string[],
  removed: [] as string[],
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
    Snapshot: {
      list: async () => msb.snapshots,
      remove: async (digest: string) => void msb.removed.push(digest),
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

// `prepare`'s records live in MSB_HOME, so each test gets its own.
let prepared: string;
/** Records a template as prepared `days` ago, as `prepare` would have. */
const recordPreparedAgo = (name: string, days: number) => {
  writeFileSync(join(prepared, name), "");
  utimesSync(join(prepared, name), ago(days), ago(days));
};

beforeEach(() => {
  process.env.MSB_HOME = mkdtempSync(join(tmpdir(), "msb-home-"));
  prepared = join(process.env.MSB_HOME, "eve-plus-prepared");
  mkdirSync(prepared);
  msb.sandboxes = [];
  msb.snapshots = [];
  msb.destroyed = [];
  msb.removed = [];
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

  it("keeps the latest build's template however old, and finds others unused past the cutoff", async () => {
    const template = (name: string, createdDaysAgo: number) => ({
      name: `eve-plus-tpl-${name}`,
      digest: `sha256:${name}`,
      createdAt: ago(createdDaysAgo),
    });
    msb.snapshots = [
      template("in-use", 400),
      template("rolled-back", 40),
      template("unrecorded", 90),
      template("recent", 3),
      { name: null, digest: "sha256:unnamed", createdAt: ago(100) },
    ];
    // The running build reused a template built long ago; a later build that was rolled back prepared another.
    recordPreparedAgo("eve-plus-tpl-in-use", 30);
    recordPreparedAgo("eve-plus-tpl-rolled-back", 31);
    const stale = await find();
    expect(stale.map((item) => item.name).sort()).toEqual([
      "eve-plus-tpl-rolled-back",
      "eve-plus-tpl-unrecorded",
    ]);
    for (const item of stale) await item.remove();
    expect(msb.removed.sort()).toEqual(["sha256:rolled-back", "sha256:unrecorded"]);
    expect(readdirSync(prepared)).toEqual(["eve-plus-tpl-in-use"]);
  });

  it("finds no template when no build has recorded one", async () => {
    msb.snapshots = [{ name: "eve-plus-tpl-old", digest: "sha256:old", createdAt: ago(400) }];
    expect(await find()).toEqual([]);
  });
});
