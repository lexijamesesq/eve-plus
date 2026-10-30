import type { ExecEvent, ExecHandle, Sandbox } from "microsandbox";
import { describe, expect, it } from "vitest";
import { createConnection } from "./connection.js";

// A sandbox whose one command runs until it is killed. Its kill() rejects, as microsandbox's does for a command
// that has already gone, so the test also sees whether a failed kill escapes.
function runningSandbox() {
  let kills = 0;
  let release: () => void = () => {};
  const killed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handle = {
    async *[Symbol.asyncIterator]() {
      yield { kind: "started", pid: 1 } as ExecEvent;
      await killed;
      yield { kind: "exited", code: 137 } as ExecEvent;
    },
    kill() {
      kills++;
      release();
      return Promise.reject(new Error("the command already exited"));
    },
  } as unknown as ExecHandle;
  const sandbox = {
    fs: () => ({}),
    execStreamWith: async () => handle,
  } as unknown as Sandbox;
  return { sandbox, kills: () => kills };
}

describe("createConnection spawn", () => {
  // eve 0.84.0 renamed the abort option from `abortSignal` to `signal`. An abort that doesn't reach kill() leaves a
  // cancelled command running in the VM.
  it("an abort passed as `signal` kills the command", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    globalThis.process.on("unhandledRejection", onUnhandled);
    try {
      const { sandbox, kills } = runningSandbox();
      const controller = new AbortController();
      const child = await createConnection(sandbox).spawn({
        signal: controller.signal,
        command: "sleep 300",
        env: {},
        workingDirectory: "/workspace",
      });
      controller.abort();
      const status = await Promise.race([
        child.wait(),
        new Promise((resolve) => setTimeout(() => resolve("still running"), 1_000)),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect({ kills: kills(), status, unhandled }).toEqual({
        kills: 1,
        status: { exitCode: 137 },
        unhandled: [],
      });
    } finally {
      globalThis.process.off("unhandledRejection", onUnhandled);
    }
  });
});
