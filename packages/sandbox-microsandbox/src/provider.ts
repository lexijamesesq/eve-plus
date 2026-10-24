import { createHash, randomUUID } from "node:crypto";
import type { SandboxSession } from "eve/sandbox";
import {
  defineSandboxProvider,
  type SandboxProvider,
  type SandboxProviderImplementation,
  type SandboxSessionContext,
  SandboxSessionGoneError,
  SandboxTemplateNotProvisionedError,
  type WithPrepareOption,
} from "eve/sandbox/provider";
import {
  NetworkPolicy,
  Sandbox,
  SandboxAlreadyExistsError,
  SandboxNotFoundError,
  Snapshot,
} from "microsandbox";
import { createConnection } from "./connection.js";
import { type MicrosandboxNetworkPolicy, resolveNetworkPolicy } from "./network-policy.js";
import { assertPinnedRuntime, MICROSANDBOX_VERSION } from "./runtime.js";

export const PROVIDER_NAME = "eve-plus-microsandbox";
/** Raise when MicrosandboxState changes incompatibly; eve then starts recorded sessions fresh. */
export const STATE_PROTOCOL_VERSION = 1;

/** debian:trixie-slim, multi-arch index digest. */
export const DEFAULT_IMAGE =
  "debian:trixie-slim@sha256:62bd423aeee912639ca8ee681c2b762cb3e25137e0a92b20be455898a9f034ad";

const WORKSPACE_ROOT = "/workspace";

export interface MicrosandboxEnvironmentOptions {
  /** Base OCI image, pinned by digest (`name@sha256:…`). It must provide bash. */
  readonly image?: string;
  /** vCPUs per sandbox. @default 1 */
  readonly cpus?: number;
  /** Memory per sandbox in MiB. @default 1024 */
  readonly memoryMib?: number;
}

export interface MicrosandboxOpenOptions {
  /** The sandbox's network policy, fixed for its life. @default "deny-all" */
  readonly networkPolicy?: MicrosandboxNetworkPolicy;
}

export type MicrosandboxArtifact = {
  readonly snapshot: {
    readonly digest: string;
    readonly reference: string;
    readonly referenceKind: "id" | "path";
  };
  readonly templateKey: string;
  readonly msbVersion: string;
};

export type MicrosandboxState = {
  readonly sandboxName: string;
  readonly msbVersion: string;
};

export const MicrosandboxSandbox: SandboxProvider<
  WithPrepareOption<MicrosandboxEnvironmentOptions, SandboxSession>,
  MicrosandboxOpenOptions | undefined,
  SandboxSession
> = defineSandboxProvider({
  name: PROVIDER_NAME,
  stateProtocolVersion: STATE_PROTOCOL_VERSION,
  environment: createImplementation,
});

/** One environment's lifecycle. Exported for the unit tests, not from the package. */
export function createImplementation(
  options: MicrosandboxEnvironmentOptions,
): SandboxProviderImplementation<
  MicrosandboxOpenOptions | undefined,
  MicrosandboxArtifact,
  MicrosandboxState,
  Record<never, never>
> {
  const image = options.image ?? DEFAULT_IMAGE;
  if (!/@sha256:[0-9a-f]{64}$/.test(image)) {
    throw new Error(
      `The microsandbox provider's image must be pinned by digest (name@sha256:…), got "${image}".`,
    );
  }
  const cpus = options.cpus ?? 1;
  const memoryMib = options.memoryMib ?? 1024;

  return {
    async prepare(ctx): Promise<MicrosandboxArtifact> {
      await assertPinnedRuntime();
      const templateKey = ctx.templateKey({ image, msbVersion: MICROSANDBOX_VERSION });
      const snapshotName = `eve-plus-tpl-${templateKey}`;
      const cached = (await Snapshot.list()).find((entry) => entry.name === snapshotName);
      if (cached !== undefined) {
        ctx.log(`reusing template snapshot "${snapshotName}"`);
        const snapshot = await Snapshot.open(cached.digest);
        return artifactFor(snapshot, templateKey);
      }

      const buildName = `eve-plus-tpl-${templateKey.slice(0, 24)}-${randomUUID().slice(0, 8)}`;
      ctx.log(`starting template build sandbox from "${image}"`);
      // The build runs allow-all, as eve's Docker provider does, so an authored prepare can
      // install packages. Sessions start under their own policy.
      const sandbox = await Sandbox.builder(buildName)
        .image(image)
        .cpus(cpus)
        .memory(memoryMib)
        .network((network) => network.policy(NetworkPolicy.allowAll()))
        .create();
      let snapshot: Snapshot | undefined;
      try {
        const bash = await sandbox.execWith("/bin/sh", (exec) =>
          exec.args(["-c", "command -v bash"]),
        );
        if (bash.code !== 0) throw new Error(`The sandbox image "${image}" must provide bash.`);
        const workspace = await sandbox.execWith("mkdir", (exec) =>
          exec.args(["-p", WORKSPACE_ROOT]).user("root"),
        );
        if (workspace.code !== 0) {
          throw new Error(`Could not create ${WORKSPACE_ROOT}: ${workspace.stderr().trim()}`);
        }
        await ctx.populate(createConnection(sandbox));
        ctx.log("stopping template build sandbox");
        await sandbox.stop();
        ctx.log(`capturing template snapshot "${snapshotName}"`);
        snapshot = await (await Sandbox.get(buildName)).snapshot(snapshotName);
        return artifactFor(snapshot, templateKey);
      } catch (error) {
        if (snapshot !== undefined) await Snapshot.remove(snapshot.digest).catch(() => {});
        throw error;
      } finally {
        await removeSandbox(buildName);
      }
    },

    async start(ctx, open: MicrosandboxOpenOptions | undefined, artifact: MicrosandboxArtifact) {
      const policy = resolveNetworkPolicy(open?.networkPolicy);
      await assertPinnedRuntime();
      const sandboxName = sessionSandboxName(ctx);
      const sandbox = await openOrRestore(sandboxName, artifact, { cpus, memoryMib, policy });
      const state: MicrosandboxState = { sandboxName, msbVersion: MICROSANDBOX_VERSION };
      return { connection: createConnection(sandbox), state };
    },

    async resume(_ctx, _artifact, state: MicrosandboxState) {
      if (typeof state?.sandboxName !== "string") {
        throw new Error("The microsandbox provider's recorded session state is invalid.");
      }
      await assertPinnedRuntime();
      let handle: Awaited<ReturnType<typeof Sandbox.get>>;
      try {
        handle = await Sandbox.get(state.sandboxName);
      } catch (error) {
        if (error instanceof SandboxNotFoundError) {
          throw new SandboxSessionGoneError(
            `microsandbox sandbox "${state.sandboxName}" no longer exists.`,
          );
        }
        throw error;
      }
      return createConnection(await handle.connectOrStart({ detached: true }));
    },

    async onSessionEnd(ctx, state: MicrosandboxState | null) {
      await removeSandbox(state?.sandboxName ?? sessionSandboxName(ctx));
    },
  };
}

function artifactFor(snapshot: Snapshot, templateKey: string): MicrosandboxArtifact {
  return {
    snapshot: {
      digest: snapshot.digest,
      reference: snapshot.reference,
      referenceKind: snapshot.referenceKind,
    },
    templateKey,
    msbVersion: MICROSANDBOX_VERSION,
  };
}

/** Native name from the session id and the app's sandbox storage path, as eve's Docker provider does. */
export function sessionSandboxName(ctx: Pick<SandboxSessionContext, "session" | "storagePath">) {
  const hash = createHash("sha256")
    .update(JSON.stringify([PROVIDER_NAME, ctx.storagePath, ctx.session.id]))
    .digest("hex");
  return `eve-plus-sbx-${hash.slice(0, 32)}`;
}

async function openOrRestore(
  sandboxName: string,
  artifact: MicrosandboxArtifact,
  config: { cpus: number; memoryMib: number; policy: MicrosandboxNetworkPolicy },
): Promise<Sandbox> {
  const existing = await connectIfExists(sandboxName);
  if (existing !== undefined) return existing;

  const templates = await Snapshot.list();
  if (!templates.some((entry) => entry.digest === artifact.snapshot.digest)) {
    throw new SandboxTemplateNotProvisionedError({
      providerName: PROVIDER_NAME,
      reason: `microsandbox has no snapshot ${artifact.snapshot.digest}: it was removed, or the build ran against another MSB_HOME.`,
      templateKey: artifact.templateKey,
    });
  }
  const policy =
    config.policy === "allow-all"
      ? NetworkPolicy.builder().defaultAllow()
      : NetworkPolicy.builder().defaultDeny();
  try {
    return await Sandbox.restore({
      reference: artifact.snapshot.reference,
      referenceKind: artifact.snapshot.referenceKind,
    })
      .name(sandboxName)
      .cpus(config.cpus)
      .memory(config.memoryMib)
      .networkPolicy(policy)
      .restore();
  } catch (error) {
    // Another caller created it first; theirs is the session's sandbox.
    if (!(error instanceof SandboxAlreadyExistsError)) throw error;
    const raced = await connectIfExists(sandboxName);
    if (raced === undefined) throw error;
    return raced;
  }
}

async function connectIfExists(sandboxName: string): Promise<Sandbox | undefined> {
  try {
    return await (await Sandbox.get(sandboxName)).connectOrStart({ detached: true });
  } catch (error) {
    if (error instanceof SandboxNotFoundError) return undefined;
    throw error;
  }
}

async function removeSandbox(sandboxName: string): Promise<void> {
  try {
    await (await Sandbox.get(sandboxName)).destroy();
  } catch (error) {
    if (!(error instanceof SandboxNotFoundError)) throw error;
  }
}
