import { dirname } from "node:path/posix";
import { SANDBOX_AGENT_ENV, type SandboxConnection } from "eve/sandbox/provider";
import type { ExecOutput, Sandbox } from "microsandbox";
import { adaptExecToSandboxProcess } from "./process.js";

type SpawnOptions = Parameters<SandboxConnection["spawn"]>[0] & {
  readonly signal?: AbortSignal;
  readonly abortSignal?: AbortSignal;
};

/** A connection to one running microsandbox VM. */
export function createConnection(sandbox: Sandbox): SandboxConnection {
  const fs = sandbox.fs();
  return {
    async spawn(options: SpawnOptions) {
      const { command, env, workingDirectory } = options;
      // eve 0.84.0 renamed the option to `signal`; 0.83 passes `abortSignal`. Whichever arrives must kill the command.
      const signal = options.signal ?? options.abortSignal;
      signal?.throwIfAborted();
      // A sandbox restored from a snapshot doesn't keep the template's environment, so the agent
      // marker goes on every command.
      const handle = await sandbox.execStreamWith("bash", (exec) =>
        exec
          .args(["-lc", command])
          .cwd(workingDirectory)
          .envs({ ...SANDBOX_AGENT_ENV, ...env }),
      );
      const process = adaptExecToSandboxProcess(handle);
      // kill() is typed as PromiseLike, which has no catch().
      const kill = () => void Promise.resolve(process.kill()).catch(() => {});
      signal?.addEventListener("abort", kill, { once: true });
      // An abort during the exec await above fired before the listener existed.
      if (signal?.aborted) kill();
      return process;
    },

    async readFile({ path }) {
      if (!(await fs.exists(path))) return null;
      if ((await fs.stat(path)).kind === "directory") {
        throw new Error(`Cannot read "${path}" from the sandbox: it is a directory.`);
      }
      return await fs.read(path);
    },

    async writeFiles({ files }) {
      for (const file of files) {
        expectSuccess(
          await sandbox.execWith("mkdir", (exec) => exec.args(["-p", "--", dirname(file.path)])),
          `create the parent directory of "${file.path}"`,
        );
        await fs.write(file.path, file.content);
      }
    },

    async removePath({ force, path, recursive }) {
      const flags = `${recursive === true ? "r" : ""}${force === true ? "f" : ""}`;
      expectSuccess(
        await sandbox.execWith("rm", (exec) =>
          exec.args([...(flags.length > 0 ? [`-${flags}`] : []), "--", path]),
        ),
        `remove "${path}"`,
      );
    },

    async stop() {
      await sandbox.stop();
    },
  };
}

function expectSuccess(output: ExecOutput, action: string): void {
  if (output.code !== 0) {
    throw new Error(
      `Could not ${action} in the sandbox (exit ${output.code}): ${output.stderr().trim()}`,
    );
  }
}
