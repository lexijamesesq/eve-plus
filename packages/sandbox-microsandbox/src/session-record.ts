import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Which eve session each of this provider's VMs belongs to: one small file per VM name, kept beside
 * microsandbox's own state. eve gives a session's storage path only to the provider, so nothing else can work
 * out a session's VM name; this is what lets `staleSandboxState` connect a VM back to its session. It isn't a
 * label on the VM because microsandbox 0.7.10's restore from a snapshot takes none, and a listed VM's handle has
 * no typed labels to read back. Internal to the package.
 */
function recordPath(sandboxName: string): string | undefined {
  // A VM name becomes a file name, so one that could leave the directory gets no record.
  if (!/^[\w-][\w.-]*$/.test(sandboxName)) return undefined;
  // Read on every call: the provider and the clean-up job resolve it as microsandbox does, from the same
  // environment.
  const home = process.env.MSB_HOME || join(homedir(), ".microsandbox");
  return join(home, "eve-plus-sessions", `${sandboxName}.json`);
}

/**
 * Records the VM's session, replacing any earlier record in one rename. A failure is swallowed, because losing
 * the record must not break the session: the VM is then judged by its last use alone, as a VM without a record
 * is, until the next start or resume records it.
 */
export async function recordSandboxSession(sandboxName: string, sessionId: string): Promise<void> {
  const path = recordPath(sandboxName);
  if (path === undefined) return;
  const pending = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(pending, JSON.stringify({ sessionId }));
    await rename(pending, path);
  } catch {
    await rm(pending, { force: true }).catch(() => {});
  }
}

/** The session recorded for a VM, or `undefined` when there is no record or it can't be read. */
export async function recordedSandboxSession(sandboxName: string): Promise<string | undefined> {
  const path = recordPath(sandboxName);
  if (path === undefined) return undefined;
  try {
    const sessionId = JSON.parse(await readFile(path, "utf8"))?.sessionId;
    return typeof sessionId === "string" ? sessionId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Removes a VM's record once the VM is gone. A failure is swallowed: a VM's name is derived from its session id,
 * so a record left behind can only ever name the right session.
 */
export async function forgetSandboxSession(sandboxName: string): Promise<void> {
  const path = recordPath(sandboxName);
  if (path === undefined) return;
  await rm(path, { force: true }).catch(() => {});
}
