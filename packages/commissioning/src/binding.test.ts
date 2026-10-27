import type { ToolContext } from "eve/tools";
import { beforeEach, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  state: { commissionIds: [] as string[] },
  context: undefined as { originSessionId: string; activeSessionId?: string } | undefined,
}));
vi.mock("eve/context", () => ({
  defineState: () => ({
    get: () => host.state,
    update: (fn: (value: typeof host.state) => typeof host.state) => {
      host.state = fn(host.state);
    },
  }),
}));
vi.mock("../extension/extension.js", () => ({
  default: {
    config: {
      workerPrincipalId: "worker",
      resolveSessionPrincipal: () => ({ verified: true, principalId: "owner" }),
    },
  },
}));
vi.mock("../extension/lib/runtime.js", () => ({
  runtime: () => ({ store: { context: () => host.context } }),
}));

import { boundOwner } from "../extension/lib/binding.js";

function context(id: string): Pick<ToolContext, "session"> {
  const auth = {
    authenticator: "verified-fixture",
    principalId: "actual-initiator",
    principalType: "user",
    attributes: {},
  };
  return {
    session: { id, auth: { current: auth, initiator: auth }, turn: { id: "turn", sequence: 1 } },
  };
}
beforeEach(() => {
  host.state = { commissionIds: [] };
  host.context = undefined;
});
it("revokes a stale state binding after an explicit active-session CAS", () => {
  host.state = { commissionIds: ["one"] };
  host.context = { originSessionId: "old", activeSessionId: "new" };
  expect(() => boundOwner(context("old"), "one")).toThrow("different active session");
  host.state = { commissionIds: [] };
  expect(boundOwner(context("new"), "one")).toEqual({ verified: true, principalId: "owner" });
});
it("retains original-session and authored continuation bindings before any explicit rebind", () => {
  host.context = { originSessionId: "original" };
  expect(boundOwner(context("original"), "one").principalId).toBe("owner");
  expect(() => boundOwner(context("unrelated"), "one")).toThrow("not bound");
  host.state = { commissionIds: ["one"] };
  expect(boundOwner(context("authored-continuation"), "one").principalId).toBe("owner");
});
