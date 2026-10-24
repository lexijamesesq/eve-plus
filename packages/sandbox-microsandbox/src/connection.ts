import { dirname } from "node:path/posix";
import { SANDBOX_AGENT_ENV, type SandboxConnection } from "eve/sandbox/provider";
import type { ExecOutput, Sandbox } from "microsandbox";
import { adaptExecToSandboxProcess } from "./process.js";

/** A connection to one running microsandbox VM. */
export function createConnection(sandbox: Sandbox): SandboxConnection {
  const fs = sandbox.fs();
  return {
    async spawn({ abortSignal, command, env, workingDirectory }) {
      abortSignal?.throwIfAborted();
      // A sandbox restored from a snapshot doesn't keep the template's environment, so the agent
      // marker goes on every command.
      const handle = await sandbox.execStreamWith("bash", (exec) =>
        exec
          .args(["-lc", command])
          .cwd(workingDirectory)
          .envs({ ...SANDBOX_AGENT_ENV, ...env }),
      );
      const process = adaptExecToSandboxProcess(handle);
      abortSignal?.addEventListener("abort", () => void process.kill().catch(() => {}), {
        once: true,
      });
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
