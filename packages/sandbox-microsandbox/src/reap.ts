import { Sandbox, SandboxNotFoundError } from "microsandbox";
import { forgetSandboxSession, recordedSandboxSession } from "./session-record.js";

/** One of this provider's VMs that nothing has used lately, and how to remove it. */
export interface StaleSandboxState {
  readonly name: string;
  readonly remove: () => Promise<void>;
}

/**
 * Finds this provider's VMs in `MSB_HOME` that nothing has used for `unusedForMs`, by microsandbox's own record of
 * them, leaving out any whose session `isSessionLive` reports live. A session stranded by an eve upgrade never comes
 * back for its VM, which is the leak this exists for. A running VM is never stale. Templates are left alone.
 *
 * eve can't list its sessions, so without `isSessionLive` a VM's last use stands for its session's liveness:
 * microsandbox updates a VM's record whenever it starts or stops, and an idle timeout stops a VM soon after its last
 * command. Before eve 1.0.0-rc.11 every turn resumed the session's VM when it started; on 1.0.0-rc.11 and later only
 * an operation that needs the sandbox does, so a live session that doesn't use its sandbox looks unused, and
 * removing its VM loses that VM's files (eve's resume then finds it gone and the session continues in a fresh
 * sandbox).
 *
 * `isSessionLive` closes that gap. The provider records each VM's session when it starts or resumes it, and a VM
 * past the cutoff is stale only if `isSessionLive` returns false for that session's id, however long ago the VM was
 * last used. The id is the `SandboxSessionContext.session.id` eve gave the provider: the session's own id, or for a
 * subagent that shares its parent's sandbox, the parent's id. A VM with no recorded session, which is one that
 * release 0.3.3 or earlier created and nothing has used since, is judged by its last use alone. If `isSessionLive`
 * throws or rejects, so does this call, and nothing is returned to remove.
 */
export async function staleSandboxState(options: {
  readonly unusedForMs: number;
  readonly now?: number;
  readonly isSessionLive?: (sessionId: string) => boolean | Promise<boolean>;
}): Promise<StaleSandboxState[]> {
  const cutoff = (options.now ?? Date.now()) - options.unusedForMs;
  const { isSessionLive } = options;
  const stale: StaleSandboxState[] = [];
  let cursor: string | undefined;
  do {
    const page = await (cursor === undefined
      ? Sandbox.list()
      : Sandbox.listWith((list) => list.cursor(cursor as string)));
    for (const handle of page.sandboxes) {
      if (!handle.name.startsWith("eve-plus-")) continue;
      const lastUsed = (handle.updatedAt ?? handle.createdAt)?.getTime();
      if (handle.status === "running" || lastUsed === undefined || lastUsed > cutoff) continue;
      if (isSessionLive !== undefined) {
        const sessionId = await recordedSandboxSession(handle.name);
        if (sessionId !== undefined && (await isSessionLive(sessionId))) continue;
      }
      stale.push({ name: handle.name, remove: () => destroy(handle.name) });
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return stale;
}

/** Removes a VM and the record of its session, unless something started the VM since it was found stale. */
async function destroy(name: string): Promise<void> {
  try {
    const handle = await Sandbox.get(name);
    if (handle.status === "running") return;
    await handle.destroy();
  } catch (error) {
    if (!(error instanceof SandboxNotFoundError)) throw error;
  }
  await forgetSandboxSession(name);
}
