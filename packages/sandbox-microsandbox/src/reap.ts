import { Sandbox, SandboxNotFoundError } from "microsandbox";

/** One of this provider's VMs that nothing has used lately, and how to remove it. */
export interface StaleSandboxState {
  readonly name: string;
  readonly remove: () => Promise<void>;
}

/**
 * Finds this provider's VMs in `MSB_HOME` that nothing has used for `unusedForMs`, by microsandbox's own record of
 * them. eve can't list its sessions, so a VM's last use stands for its session's liveness: microsandbox updates a
 * VM's record whenever it starts or stops, and an idle timeout stops a VM soon after its last command. A running VM
 * is never stale. Removing a live session's VM loses only its files: eve's resume then finds it gone and the session
 * continues in a fresh sandbox. A session stranded by an eve upgrade never comes back for its VM at all, which is the
 * leak this exists for. Templates are left alone.
 */
export async function staleSandboxState(options: {
  readonly unusedForMs: number;
  readonly now?: number;
}): Promise<StaleSandboxState[]> {
  const cutoff = (options.now ?? Date.now()) - options.unusedForMs;
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
      stale.push({ name: handle.name, remove: () => destroy(handle.name) });
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return stale;
}

/** Removes a VM unless something started it since it was found stale. */
async function destroy(name: string): Promise<void> {
  try {
    const handle = await Sandbox.get(name);
    if (handle.status === "running") return;
    await handle.destroy();
  } catch (error) {
    if (!(error instanceof SandboxNotFoundError)) throw error;
  }
}
