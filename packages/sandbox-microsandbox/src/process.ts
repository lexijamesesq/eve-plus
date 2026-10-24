// Copyright 2026 Vercel, Inc. and contributors
// SPDX-License-Identifier: Apache-2.0
//
// Derived from eve's microsandbox provider (packages/eve/src/execution/sandbox/bindings/
// microsandbox-process.ts at vercel/eve a2c6d64e). Modified: typed through eve's public
// SandboxConnection, kill is idempotent, and a stream error after exit no longer closes errored
// streams. See LICENSE-APACHE and NOTICE.

import type { SandboxConnection } from "eve/sandbox/provider";
import type { ExecEvent, ExecHandle } from "microsandbox";

type SandboxProcess = Awaited<ReturnType<SandboxConnection["spawn"]>>;

// Output can trail the exit event; drain briefly, then close the streams.
const POST_EXIT_DRAIN_MS = 100;

export function adaptExecToSandboxProcess(command: ExecHandle): SandboxProcess {
  let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let stderrController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let exitCode: number | undefined;
  let killed: Promise<void> | undefined;
  let resolveFinished: (() => void) | undefined;
  let rejectFinished: ((error: unknown) => void) | undefined;
  const finished = new Promise<void>((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });
  // wait() still sees a failure; a caller that never waits mustn't crash the process with it.
  finished.catch(() => {});

  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      stdoutController = controller;
    },
  });
  const stderr = new ReadableStream<Uint8Array>({
    start(controller) {
      stderrController = controller;
    },
  });

  const fail = (error: unknown) => {
    stdoutController?.error(error);
    stderrController?.error(error);
    rejectFinished?.(error);
  };

  void (async () => {
    const iterator = command[Symbol.asyncIterator]();
    try {
      for (;;) {
        const result =
          exitCode === undefined
            ? await iterator.next()
            : await nextWithTimeout(iterator, POST_EXIT_DRAIN_MS);
        if (result === "timeout" || result.done === true) break;

        const event = result.value;
        if (event.kind === "stdout") stdoutController?.enqueue(event.data);
        else if (event.kind === "stderr") stderrController?.enqueue(event.data);
        else if (event.kind === "exited") exitCode = event.code;
      }
    } catch (error) {
      // Settle once: closing the streams after erroring them would throw out of this task.
      fail(error);
      return;
    } finally {
      void iterator.return?.().catch(() => {});
    }
    if (exitCode === undefined) {
      fail(new Error("The microsandbox command ended without an exit event."));
      return;
    }
    stdoutController?.close();
    stderrController?.close();
    resolveFinished?.();
  })();

  return {
    stdout,
    stderr,
    async wait() {
      await finished;
      return { exitCode: exitCode ?? 0 };
    },
    kill() {
      killed ??= command.kill();
      return killed;
    },
  };
}

async function nextWithTimeout(
  iterator: AsyncIterator<ExecEvent>,
  timeoutMs: number,
): Promise<IteratorResult<ExecEvent> | "timeout"> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<"timeout">((resolve) => {
        timeout = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
