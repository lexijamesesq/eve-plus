import { readFileSync } from "node:fs";
import {
  type SandboxPrepareContext,
  type SandboxSessionContext,
  SandboxSessionGoneError,
  SandboxTemplateNotProvisionedError,
} from "eve/sandbox/provider";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UnsupportedNetworkPolicyError } from "./network-policy.js";
import {
  createImplementation,
  type MicrosandboxArtifact,
  NetworkPolicyConflictError,
  PROVIDER_NAME,
  STATE_PROTOCOL_VERSION,
} from "./provider.js";
import { MICROSANDBOX_VERSION, MicrosandboxRuntimeMismatchError } from "./runtime.js";

// An in-memory stand-in for the microsandbox SDK: named sandboxes, indexed snapshots, and a
// record of every restore. The real-VM behaviour is proven on a KVM host, not here.
const msb = vi.hoisted(() => ({
  calls: [] as string[],
  raceOnRestore: false,
  raceWinnerEgress: undefined as "deny" | "allow" | undefined,
  restored: [] as { name?: string; cpus?: number; memory?: number; policy?: string }[],
  failDestroy: false,
  removedSnapshots: [] as string[],
  runtime: { origin: "sdk_package", msbPath: "/pkg/msb", libkrunfwPath: "/pkg/fw" },
  // Each sandbox's default egress, as microsandbox records it in the sandbox's config.
  sandboxes: new Map<string, "deny" | "allow">(),
  snapshots: [] as { name: string; digest: string }[],
  version: "0.7.10" as string | null,
}));

vi.mock("microsandbox", () => {
  class SandboxNotFoundError extends Error {}
  class SandboxAlreadyExistsError extends Error {}
  const sandbox = (name: string) => ({
    name,
    fs: () => ({}),
    stop: async () => {},
    execWith: async () => ({ code: 0, stderr: () => "" }),
  });
  const policyBuilder = () => {
    const builder = {
      kind: "unset",
      defaultDeny() {
        builder.kind = "deny-all";
        return builder;
      },
      defaultAllow() {
        builder.kind = "allow-all";
        return builder;
      },
    };
    return builder;
  };
  return {
    NetworkPolicy: { builder: policyBuilder, allowAll: () => ({}) },
    SandboxAlreadyExistsError,
    SandboxNotFoundError,
    resolveRuntime: () => msb.runtime,
    resolveRuntimeVersion: async () => msb.version,
    Snapshot: {
      list: async () => msb.snapshots,
      remove: async (digest: string) => {
        msb.removedSnapshots.push(digest);
      },
    },
    Sandbox: {
      builder(name: string) {
        const builder = {
          image: () => builder,
          cpus: () => builder,
          memory: () => builder,
          network: () => builder,
          async create() {
            msb.sandboxes.set(name, "allow");
            return sandbox(name);
          },
        };
        return builder;
      },
      async get(name: string) {
        msb.calls.push(`get ${name}`);
        const egress = msb.sandboxes.get(name);
        if (egress === undefined) throw new SandboxNotFoundError(name);
        return {
          configJson: JSON.stringify({ network: { policy: { default_egress: egress } } }),
          connectOrStart: async () => sandbox(name),
          destroy: async () => {
            msb.calls.push(`destroy ${name}`);
            if (msb.failDestroy) throw new Error("destroy failed");
            msb.sandboxes.delete(name);
          },
          snapshot: async (snapshotName: string) => {
            const snapshot = {
              digest: `sha256:${snapshotName}`,
              reference: `/s/${snapshotName}`,
              referenceKind: "path",
            };
            msb.snapshots.push({ name: snapshotName, digest: snapshot.digest });
            return snapshot;
          },
        };
      },
      restore() {
        const record: (typeof msb.restored)[number] = {};
        const builder = {
          name(value: string) {
            record.name = value;
            return builder;
          },
          cpus(value: number) {
            record.cpus = value;
            return builder;
          },
          memory(value: number) {
            record.memory = value;
            return builder;
          },
          networkPolicy(value: { kind: string }) {
            record.policy = value.kind;
            return builder;
          },
          async restore() {
            const name = record.name as string;
            msb.calls.push(`restore ${name}`);
            msb.sandboxes.set(name, record.policy === "allow-all" ? "allow" : "deny");
            if (msb.raceOnRestore) {
              if (msb.raceWinnerEgress !== undefined) msb.sandboxes.set(name, msb.raceWinnerEgress);
              throw new SandboxAlreadyExistsError(name);
            }
            msb.restored.push(record);
            return sandbox(name);
          },
        };
        return builder;
      },
    },
  };
});

const artifact: MicrosandboxArtifact = {
  snapshot: { digest: "sha256:tpl", reference: "/msb/snapshots/tpl", referenceKind: "path" },
  templateKey: "key",
  msbVersion: MICROSANDBOX_VERSION,
};

const ctx = {
  kind: "session",
  resolveProjectPath: (path: string) => path,
  session: { id: "session-1" },
  storagePath: "/app/.eve/sandbox",
} as unknown as SandboxSessionContext;

beforeEach(() => {
  msb.calls = [];
  msb.failDestroy = false;
  msb.raceOnRestore = false;
  msb.raceWinnerEgress = undefined;
  msb.removedSnapshots = [];
  msb.restored = [];
  msb.runtime = { origin: "sdk_package", msbPath: "/pkg/msb", libkrunfwPath: "/pkg/fw" };
  msb.sandboxes = new Map();
  msb.snapshots = [{ name: "eve-plus-tpl-key", digest: "sha256:tpl" }];
  msb.version = MICROSANDBOX_VERSION;
});

describe("start", () => {
  it("opens with no network option in deny-all", async () => {
    await createImplementation({}).start(ctx, undefined, artifact);
    expect(msb.restored).toEqual([
      expect.objectContaining({ policy: "deny-all", cpus: 1, memory: 1024 }),
    ]);
  });

  it("opens allow-all only when asked", async () => {
    await createImplementation({}).start(ctx, { networkPolicy: "allow-all" }, artifact);
    expect(msb.restored[0]?.policy).toBe("allow-all");
  });

  it("rejects an object policy before touching microsandbox", async () => {
    const open = { networkPolicy: { allow: ["*"] } } as never;
    await expect(createImplementation({}).start(ctx, open, artifact)).rejects.toThrow(
      UnsupportedNetworkPolicyError,
    );
    expect(msb.calls).toEqual([]);
  });

  it("applies the CPU and memory options", async () => {
    await createImplementation({ cpus: 2, memoryMib: 2048 }).start(ctx, undefined, artifact);
    expect(msb.restored[0]).toEqual(expect.objectContaining({ cpus: 2, memory: 2048 }));
  });

  it("reuses an existing sandbox instead of restoring", async () => {
    const implementation = createImplementation({});
    const first = await implementation.start(ctx, undefined, artifact);
    const second = await implementation.start(ctx, undefined, artifact);
    expect(second.state).toEqual(first.state);
    expect(msb.restored).toHaveLength(1);
  });

  describe("names the sandbox from the session id and storage path only", () => {
    const nameFor = async (context: SandboxSessionContext, open?: { networkPolicy: "allow-all" }) =>
      (await createImplementation({}).start(context, open, artifact)).state.sandboxName;

    it("has a bounded, provider-prefixed form", async () => {
      expect(await nameFor(ctx)).toMatch(/^eve-plus-sbx-[0-9a-f]{32}$/);
    });

    it("changes with the session id", async () => {
      const other = { ...ctx, session: { id: "session-2" } } as SandboxSessionContext;
      expect(await nameFor(other)).not.toBe(await nameFor(ctx));
    });

    it("changes with the storage path", async () => {
      const other = { ...ctx, storagePath: "/other-app/.eve/sandbox" } as SandboxSessionContext;
      expect(await nameFor(other)).not.toBe(await nameFor(ctx));
    });

    it("ignores the open options and the artifact", async () => {
      const first = await nameFor(ctx, { networkPolicy: "allow-all" });
      msb.sandboxes.clear();
      const otherArtifact = { ...artifact, templateKey: "other-key" };
      const second = (await createImplementation({}).start(ctx, undefined, otherArtifact)).state
        .sandboxName;
      expect(second).toBe(first);
    });
  });

  it("refuses deny-all for a sandbox created allow-all, before booting it", async () => {
    const implementation = createImplementation({});
    await implementation.start(ctx, { networkPolicy: "allow-all" }, artifact);
    await expect(implementation.start(ctx, undefined, artifact)).rejects.toThrow(
      NetworkPolicyConflictError,
    );
  });

  it("keeps a deny-all sandbox's policy when allow-all is asked later", async () => {
    const implementation = createImplementation({});
    const first = await implementation.start(ctx, undefined, artifact);
    const again = await implementation.start(ctx, { networkPolicy: "allow-all" }, artifact);
    expect(again.state).toEqual(first.state);
    expect(msb.sandboxes.get(first.state.sandboxName)).toBe("deny");
  });

  it("applies the policy check to the sandbox a racing caller created", async () => {
    msb.raceOnRestore = true;
    msb.raceWinnerEgress = "allow";
    await expect(createImplementation({}).start(ctx, undefined, artifact)).rejects.toThrow(
      NetworkPolicyConflictError,
    );
  });

  it("connects to the winner when another caller restores first", async () => {
    msb.raceOnRestore = true;
    const { state } = await createImplementation({}).start(ctx, undefined, artifact);
    expect(msb.calls).toEqual([
      `get ${state.sandboxName}`,
      `restore ${state.sandboxName}`,
      `get ${state.sandboxName}`,
    ]);
  });

  it("reports a missing template snapshot", async () => {
    msb.snapshots = [];
    await expect(createImplementation({}).start(ctx, undefined, artifact)).rejects.toThrow(
      SandboxTemplateNotProvisionedError,
    );
  });

  it("refuses a runtime from anywhere but the locked package", async () => {
    msb.runtime = { ...msb.runtime, origin: "home" };
    await expect(createImplementation({}).start(ctx, undefined, artifact)).rejects.toThrow(
      MicrosandboxRuntimeMismatchError,
    );
  });

  it("refuses a runtime at another version", async () => {
    msb.version = "0.7.9";
    await expect(createImplementation({}).start(ctx, undefined, artifact)).rejects.toThrow(
      MicrosandboxRuntimeMismatchError,
    );
  });
});

describe("prepare", () => {
  const prepareCtx = {
    files: {},
    isEmpty: false,
    log: () => {},
    populate: async () => {},
    resolveProjectPath: (path: string) => path,
    resourcesDirectory: async () => undefined,
    storagePath: "/app/.eve/sandbox",
    templateKey: () => "a".repeat(64),
  } as unknown as SandboxPrepareContext;

  it("captures a snapshot and removes its build sandbox", async () => {
    msb.snapshots = [];
    const result = await createImplementation({}).prepare(prepareCtx);
    expect(result.templateKey).toBe("a".repeat(64));
    expect(result.snapshot.digest).toBe(`sha256:eve-plus-tpl-${"a".repeat(64)}`);
    expect(msb.sandboxes.size).toBe(0);
  });

  it("removes the captured snapshot when removing the build sandbox fails", async () => {
    msb.snapshots = [];
    msb.failDestroy = true;
    await expect(createImplementation({}).prepare(prepareCtx)).rejects.toThrow("destroy failed");
    expect(msb.removedSnapshots).toEqual([`sha256:eve-plus-tpl-${"a".repeat(64)}`]);
  });
});

describe("resume", () => {
  it("throws SandboxSessionGoneError when the sandbox is gone", async () => {
    const state = { sandboxName: "eve-plus-sbx-gone", msbVersion: MICROSANDBOX_VERSION };
    await expect(createImplementation({}).resume(ctx, artifact, state)).rejects.toThrow(
      SandboxSessionGoneError,
    );
  });

  it("reconnects to an existing sandbox", async () => {
    const implementation = createImplementation({});
    const { state } = await implementation.start(ctx, undefined, artifact);
    await expect(implementation.resume(ctx, artifact, state)).resolves.toBeDefined();
  });
});

describe("onSessionEnd", () => {
  it("deletes the sandbox, then succeeds again when nothing is left", async () => {
    const implementation = createImplementation({});
    const { state } = await implementation.start(ctx, undefined, artifact);
    await implementation.onSessionEnd(ctx, state, { reason: "completed" });
    await implementation.onSessionEnd(ctx, state, { reason: "completed" });
    await implementation.onSessionEnd(ctx, null, { reason: "deleted" });
    expect(msb.sandboxes.size).toBe(0);
    expect(msb.calls.filter((call) => call.startsWith("destroy"))).toHaveLength(1);
  });
});

describe("environment options", () => {
  it("requires an image pinned by digest", () => {
    expect(() => createImplementation({ image: "debian:trixie-slim" })).toThrow(/pinned by digest/);
  });
});

describe("the pinned microsandbox version", () => {
  it("matches the exact dependency in package.json", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(manifest.dependencies.microsandbox).toBe(MICROSANDBOX_VERSION);
  });
});

describe("recorded state", () => {
  it("round-trips through eve's persisted-state resolution", async () => {
    // eve's resolution isn't a public export; this test-only deep import is the one exception
    // to the package's public-imports rule (see the README).
    const { resolvePersistedSandboxSessionState } = await import(
      new URL("../node_modules/eve/dist/src/sandbox/state.js", import.meta.url).href
    );
    const { state } = await createImplementation({}).start(ctx, undefined, artifact);
    const recorded = JSON.parse(
      JSON.stringify({
        providerName: PROVIDER_NAME,
        state,
        stateProtocolVersion: STATE_PROTOCOL_VERSION,
      }),
    );
    const runtime = {
      implementation: {},
      prepare: undefined,
      providerName: PROVIDER_NAME,
      stateProtocolVersion: STATE_PROTOCOL_VERSION,
    };
    expect(resolvePersistedSandboxSessionState(recorded, runtime)).toEqual(recorded);
    expect(PROVIDER_NAME).not.toBe("microsandbox");
    expect(
      resolvePersistedSandboxSessionState({ ...recorded, providerName: "microsandbox" }, runtime),
    ).toBeNull();
  });
});
