import type { ExecEvent, ExecHandle } from "microsandbox";
import { describe, expect, it } from "vitest";
import { adaptExecToSandboxProcess } from "./process.js";

const bytes = (text: string) => new TextEncoder().encode(text);

// An exec handle whose event stream yields `events`, then throws `failure` if given.
function fakeHandle(events: ExecEvent[], failure?: Error) {
  const kills: number[] = [];
  const handle = {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
      if (failure !== undefined) throw failure;
    },
    async kill() {
      kills.push(Date.now());
    },
  };
  return { handle: handle as unknown as ExecHandle, kills };
}

describe("adaptExecToSandboxProcess", () => {
  it("streams output and resolves the exit code", async () => {
    const { handle } = fakeHandle([
      { kind: "started", pid: 1 },
      { kind: "stdout", data: bytes("out") },
      { kind: "stderr", data: bytes("err") },
      { kind: "exited", code: 3 },
    ]);
    const process = adaptExecToSandboxProcess(handle);
    const [out, err, status] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.wait(),
    ]);
    expect({ out, err, status }).toEqual({ out: "out", err: "err", status: { exitCode: 3 } });
  });

  it("rejects wait() without an unhandled error when the stream breaks after exit", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    globalThis.process.on("unhandledRejection", onUnhandled);
    try {
      const { handle } = fakeHandle([{ kind: "exited", code: 0 }], new Error("relay dropped"));
      const sandboxProcess = adaptExecToSandboxProcess(handle);
      await expect(sandboxProcess.wait()).rejects.toThrow("relay dropped");
      await expect(new Response(sandboxProcess.stdout).text()).rejects.toThrow("relay dropped");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      globalThis.process.off("unhandledRejection", onUnhandled);
    }
  });

  it("does not crash when a failed command is never waited on", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    globalThis.process.on("unhandledRejection", onUnhandled);
    try {
      const { handle } = fakeHandle([], new Error("lost"));
      const sandboxProcess = adaptExecToSandboxProcess(handle);
      sandboxProcess.stdout.cancel().catch(() => {});
      sandboxProcess.stderr.cancel().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      globalThis.process.off("unhandledRejection", onUnhandled);
    }
  });

  it("reports a successful exit when the reader cancelled the output early", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    globalThis.process.on("unhandledRejection", onUnhandled);
    try {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const handle = {
        async *[Symbol.asyncIterator]() {
          yield { kind: "stdout", data: bytes("first") } as ExecEvent;
          await gate;
          yield { kind: "stdout", data: bytes("after cancel") } as ExecEvent;
          yield { kind: "stderr", data: bytes("still read") } as ExecEvent;
          yield { kind: "exited", code: 0 } as ExecEvent;
        },
        async kill() {},
      } as unknown as ExecHandle;
      const sandboxProcess = adaptExecToSandboxProcess(handle);
      await sandboxProcess.stdout.cancel();
      release();
      const [err, status] = await Promise.all([
        new Response(sandboxProcess.stderr).text(),
        sandboxProcess.wait(),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect({ err, status, unhandled }).toEqual({
        err: "still read",
        status: { exitCode: 0 },
        unhandled: [],
      });
    } finally {
      globalThis.process.off("unhandledRejection", onUnhandled);
    }
  });

  it("kills once however often kill() is called", async () => {
    const { handle, kills } = fakeHandle([{ kind: "exited", code: 0 }]);
    const process = adaptExecToSandboxProcess(handle);
    await Promise.all([process.kill(), process.kill()]);
    await process.kill();
    expect(kills).toHaveLength(1);
  });
});
