import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Sandbox, SandboxNotFoundError, Snapshot } from "microsandbox";

/** One piece of this provider's state that nothing has used lately, and how to remove it. */
export interface StaleSandboxState {
  readonly kind: "sandbox" | "template";
  readonly name: string;
  readonly remove: () => Promise<void>;
}

/**
 * Templates prepared within this long of the latest build's are that build's. One `eve build` prepares every
 * environment of an agent within minutes.
 */
const BUILD_WINDOW_MS = 60 * 60_000;

/** Where `prepare` records each template it builds or reuses: one file per template, its time the last prepare. */
function preparedDirectory(): string {
  return join(process.env.MSB_HOME ?? join(homedir(), ".microsandbox"), "eve-plus-prepared");
}

/**
 * Records that a build prepared this template. A running agent uses the templates its last `eve build` prepared, and
 * nothing in eve tells a later process which those were, so the reaper reads them from here.
 */
export async function recordPrepared(snapshotName: string): Promise<void> {
  await mkdir(preparedDirectory(), { recursive: true });
  await writeFile(join(preparedDirectory(), snapshotName), "");
}

/** Each recorded template's last prepare time. */
async function preparedTimes(): Promise<Map<string, number>> {
  const times = new Map<string, number>();
  let names: string[];
  try {
    names = await readdir(preparedDirectory());
  } catch {
    return times;
  }
  for (const name of names) {
    times.set(name, (await stat(join(preparedDirectory(), name))).mtimeMs);
  }
  return times;
}

/**
 * Finds this provider's VMs and templates in `MSB_HOME` that nothing has used for `unusedForMs`, by microsandbox's own
 * record of them. eve can't list its sessions, so a VM's last use stands for its session's liveness: microsandbox
 * updates a VM's record whenever it starts or stops, and an idle timeout stops a VM soon after its last command. A
 * running VM is never stale. Removing a live session's VM loses only its files: eve's resume then finds it gone and
 * the session continues in a fresh sandbox. A session stranded by an eve upgrade never comes back for its VM at
 * all, which is the leak this exists for.
 *
 * A template is never stale while the latest build uses it: `prepare` records each template it builds or reuses, and
 * the ones recorded with the latest build are in use until the next build, however old. Any other template is stale
 * once its last prepare (or, unrecorded, its creation) is older than `unusedForMs`. With nothing recorded, no
 * template is. A rollback's build records its own template, and one removed earlier is rebuilt by that build.
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
      stale.push({ kind: "sandbox", name: handle.name, remove: () => destroy(handle.name) });
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);

  const prepared = await preparedTimes();
  if (prepared.size === 0) return stale;
  const latestBuild = Math.max(...prepared.values());
  for (const template of await Snapshot.list()) {
    const name = template.name;
    if (name === null || !name.startsWith("eve-plus-tpl-")) continue;
    const lastPrepared = prepared.get(name);
    if (lastPrepared !== undefined && lastPrepared >= latestBuild - BUILD_WINDOW_MS) continue;
    if ((lastPrepared ?? template.createdAt.getTime()) > cutoff) continue;
    stale.push({
      kind: "template",
      name,
      remove: async () => {
        await Snapshot.remove(template.digest);
        await rm(join(preparedDirectory(), name), { force: true });
      },
    });
  }
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
