// Copyright 2026 Vercel, Inc. and contributors
// SPDX-License-Identifier: Apache-2.0
//
// Derived from eve's microsandbox provider (packages/eve/src/execution/sandbox/bindings/
// microsandbox-process.ts at vercel/eve a2c6d64e). Modified: typed through eve's public
// SandboxConnection, kill is idempotent, a stream error after exit no longer closes errored
// streams, and a cancelled output stream no longer breaks the exit status. See LICENSE-APACHE and NOTICE.

import type { SandboxConnection } from "eve/sandbox/provider";
import type { ExecEvent, ExecHandle } from "microsandbox";

type SandboxProcess = Awaited<ReturnType<SandboxConnection["spawn"]>>;

// Output can trail the exit event; drain briefly, then close the streams.
const POST_EXIT_DRAIN_MS = 100;

export function adaptExecToSandboxProcess(command: ExecHandle): SandboxProcess {
  const stdout = outputStream();
  const stderr = outputStream();
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

  const fail = (error: unknown) => {
    stdout.error(error);
    stderr.error(error);
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
        if (event.kind === "stdout") stdout.push(event.data);
        else if (event.kind === "stderr") stderr.push(event.data);
        else if (event.kind === "exited") exitCode = event.code;
      }
    } catch (error) {
      fail(error);
      return;
    } finally {
      void iterator.return?.().catch(() => {});
    }
    if (exitCode === undefined) {
      fail(new Error("The microsandbox command ended without an exit event."));
      return;
    }
    stdout.close();
    stderr.close();
    resolveFinished?.();
  })();

  return {
    stdout: stdout.stream,
    stderr: stderr.stream,
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

/**
 * One output stream that ignores writes once it has ended, including when the reader cancels
 * it: enqueueing to or closing a cancelled stream throws, and the command's exit status must not
 * depend on whether anyone is still reading.
 */
function outputStream() {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let open = true;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      open = false;
    },
  });
  return {
    stream,
    push(chunk: Uint8Array) {
      if (open) controller?.enqueue(chunk);
    },
    close() {
      if (!open) return;
      open = false;
      controller?.close();
    },
    error(error: unknown) {
      if (!open) return;
      open = false;
      controller?.error(error);
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
