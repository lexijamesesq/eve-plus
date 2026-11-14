# Eve-Plus Sandbox: microsandbox

A sandbox provider for [eve](https://github.com/vercel/eve) that runs each session in its own [microsandbox](https://github.com/superradcompany/microsandbox) microVM, deny-all by default. It's built on eve's public `defineSandboxProvider` seam (`eve/sandbox/provider`) and uses no eve internals, so an eve release that keeps that seam can't break it.

## Install

Install it from a release tag as a git dependency, next to eve 0.91.0 or later within 0.91, or exactly 1.0.0-rc.6, 1.0.0-rc.10 or 1.0.0-rc.13:

```json
{
  "dependencies": {
    "@eve-plus/sandbox-microsandbox": "github:lexijamesesq/eve-plus#sandbox-microsandbox--v0.3.4&path:packages/sandbox-microsandbox",
    "eve": "0.91.0"
  }
}
```

The host needs `/dev/kvm`, with the process in its group. In a container, pass only `--device /dev/kvm`, set `MSB_HOME` to a writable directory, and mount the host's CA bundle read-only: the host-side `msb` runtime pulls images over HTTPS and panics with "No CA certificates were loaded from the system" without it.

## Use

```ts title="agent/sandbox.ts"
import { defineSandbox } from "eve/sandbox";
import { MicrosandboxSandbox } from "@eve-plus/sandbox-microsandbox";

export const environment = MicrosandboxSandbox.environment({
  prepare: async (sandbox) => {
    await sandbox.run({ command: "apt-get update && apt-get install -y ripgrep" });
  },
});

export default defineSandbox(() => environment.open());
```

Keep the package external. microsandbox loads its native addon from its own package tree at runtime, so it has to keep its normal layout. Add this `build` property inside your existing `defineAgent({ ... })` in `agent/agent.ts`:

```ts
build: {
  externalDependencies: ["@eve-plus/sandbox-microsandbox"],
},
```

Without it, `eve build` bundles the package, separating microsandbox's `dist/` from its `native/` addon, and the build fails with `Cannot find module '../../native/index.cjs'`.

Environment options:

| Option            | Default                                | Meaning                                                                                                          |
| ----------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `image`           | `debian:trixie-slim`, pinned by digest | Base OCI image. It must be pinned (`name@sha256:…`) and provide bash.                                            |
| `cpus`            | `1`                                    | vCPUs per sandbox.                                                                                               |
| `memoryMib`       | `1024`                                 | Memory per sandbox, in MiB.                                                                                      |
| `rootDiskMib`     | microsandbox's own                     | Root disk per sandbox, in MiB. Set when the template is built, and part of the template key.                     |
| `maxDurationSecs` | none                                   | Seconds a session VM runs before microsandbox stops it. The next access boots it again with its synced files.    |
| `idleTimeoutSecs` | none                                   | Seconds without a running command before microsandbox stops a session VM. The next access boots it again.        |
| `prepare`         | none                                   | eve's standard template setup, run once per template.                                                            |

`open()` takes `{ networkPolicy }`, described below. Without `maxDurationSecs` or `idleTimeoutSecs`, a sandbox runs until eve stops it or the session ends. Either limit stops the VM hard, so a write that hasn't been synced can be lost.

The disk is fixed at the template because a session VM is a restore of the template snapshot, and microsandbox's restore can't resize a disk. A session's disk is the template's.

## How it works

- **`prepare`** (at `eve build`) boots a template VM from the image, fails clearly if the image lacks bash, creates `/workspace` as root (as eve's Docker provider does), and runs `ctx.populate()`, which seeds workspace and skill files and runs your `prepare`. It then stops the VM and captures a disk snapshot named for the template key, which hashes the image, the microsandbox version, `rootDiskMib` when it's set, and eve's workspace, skill and sandbox-file inputs. An unchanged template is reused. The template build runs `allow-all`, so your `prepare` can install packages. A failed build removes its VM and any snapshot it captured.
- **`start`** finds the session's VM by a name derived from the session id and the app's sandbox storage path. It connects to a running VM, boots a stopped one, or restores a new one from the template snapshot under the session's network policy, always detached. Concurrent and cross-process starts converge on one VM. It then records which session the VM belongs to (see "Reaping unused VMs"). A missing template snapshot throws eve's `SandboxTemplateNotProvisionedError`, and a policy that would weaken the existing VM's throws `NetworkPolicyConflictError` (see below).
- **`resume`** reconnects to the recorded VM, booting it if it's stopped, or throws `SandboxSessionGoneError` if it no longer exists. It records the VM's session too, so a VM that an earlier release created is recorded the first time it's used again.
- **`onSessionEnd`** deletes the VM and the record of its session. It's idempotent and succeeds when nothing exists.
- **Commands** run as `bash -lc` with eve's `SANDBOX_AGENT_ENV` beneath the per-call environment, because a VM restored from a snapshot doesn't keep the template's environment. Aborting a command kills its whole process tree, including backgrounded children.

The recorded session state is `{ sandboxName, msbVersion }` under `stateProtocolVersion` 1, and the provider's name is `eve-plus-microsandbox`. eve discards state recorded under the name `microsandbox`, which belonged to the provider eve 0.83 removed.

`toolSessions` is omitted: a keyed `invokeTool` call that requests a sandbox fails, because nothing would bound how long its VM lives.

## Network policy

The provider enforces three policies, set once when a session's sandbox is created. From strictest to loosest:

- **`deny-all`:** no network.
- **`public`:** microsandbox's own `public` profile. The VM reaches public internet addresses, with DNS through the host, and is denied private, loopback, link-local, metadata and host addresses, so it can't reach the host's LAN or the host itself.
- **`allow-all`:** everything, including the host.

Every other shape rejects with `UnsupportedNetworkPolicyError` rather than being weakened: microsandbox can't inject the headers eve's `transform` rules add, and can't change a live sandbox's policy. eve's domain allowlists (`{ "allow": [...] }`) are rejected too. microsandbox's docs say a hostname rule allows HTTPS only with TLS interception or with its strict hostname mode off ("Hostname rules and HTTPS"). On microsandbox 0.7.10, a VM restored from a template built with either setting came back with interception off and strict mode on, and every HTTPS connection to an allowlisted host was reset during the handshake (curl, git and Node alike), while plain HTTP to it worked.

An absent policy means `deny-all`. eve's Docker provider defaults to `allow-all`; this one doesn't.

A sandbox keeps the policy it was created with. A later `open()` asking for a stricter policy than the session's sandbox was created with (`deny-all` for a `public` or `allow-all` sandbox, `public` for an `allow-all` one) throws `NetworkPolicyConflictError` instead of quietly handing back network access; delete the session's sandbox (`sandbox.delete()`) to start a fresh one. A sandbox whose recorded policy isn't one this provider creates counts as `allow-all`. A later `open()` asking for a looser policy reconnects to the sandbox unchanged, since eve applies open options only when a sandbox is created.

No TLS interception is configured, and the guest trusts only its image's own certificate store.

The table below is checked by the package's unit tests: each row's shape is parsed as JSON and must produce its result.

| Shape                                                                                    | Result      |
| ---------------------------------------------------------------------------------------- | ----------- |
| absent                                                                                   | `deny-all`  |
| `"deny-all"`                                                                             | `deny-all`  |
| `"public"`                                                                               | `public`    |
| `"allow-all"`                                                                            | `allow-all` |
| `{}`                                                                                     | rejects     |
| `{"allow": ["*"]}`                                                                       | rejects     |
| `{"allow": {"*": []}}`                                                                   | rejects     |
| `{"allow": ["example.com"]}`                                                             | rejects     |
| `{"allow": {"github.com": [{"transform": [{"headers": {"a": "b"}}]}]}}`                  | rejects     |
| `{"allow": {"github.com": [{"forwardURL": "https://proxy.internal"}]}}`                  | rejects     |
| `{"allow": {"github.com": [{"match": {"method": ["GET"]}, "forwardURL": "https://p"}]}}` | rejects     |
| `{"subnets": {"allow": ["10.0.0.0/8"]}}`                                                 | rejects     |
| `{"subnets": {"deny": ["10.0.0.0/8"]}}`                                                  | rejects     |
| `"DENY-ALL"`                                                                             | rejects     |
| `null`                                                                                   | rejects     |

### No live policy changes

The session has no `setNetworkPolicy()`. Two eve features look for it and stop at their own check, before doing any work, when it's absent:

- **The GitHub channel's default checkout** fails with "GitHub checkout requires a sandbox provider with mutable network policy." The remedy is a host-side checkout: override the channel's default `turn.started` handler and fetch what the agent needs outside the sandbox.
- **eve-code's firewall credential delivery** fails without it. The remedy is `vercel.delivery: "command"`.

## Runtime pinning

`microsandbox` is pinned exactly, and its platform package (which carries the `msb` VM runtime) is pinned by microsandbox itself. Before any VM work, the provider checks that `msb` resolved from that platform package (`origin: sdk_package`) at the pinned version, and throws `MicrosandboxRuntimeMismatchError` otherwise, for example when `MSB_PATH` selects another runtime.

To move to a new microsandbox release:

1. Read its changelog and security advisories.
2. Change the exact `microsandbox` version in `package.json` and `MICROSANDBOX_VERSION` in `src/runtime.ts` together. A unit test fails if they differ.
3. Run the real-VM proof below on a KVM host, and keep its output with the change.
4. Bump this package's version, so the merge cuts a new release tag.

Because the microsandbox version is part of the template key, the next `eve build` builds a fresh template.

## Reaping unused VMs

A session that never ends, such as one stranded by an eve upgrade, never runs `onSessionEnd`, so its VM and files stay on disk. `staleSandboxState({ unusedForMs, isSessionLive })` finds this provider's VMs that are stopped, that microsandbox last started or stopped before the cutoff, and whose session `isSessionLive` doesn't report live. Each item it returns has a `remove()`. Call it from a periodic job:

```ts
import { staleSandboxState } from "@eve-plus/sandbox-microsandbox";

const stale = await staleSandboxState({
  unusedForMs: 7 * 24 * 60 * 60_000,
  isSessionLive: (sessionId) => liveSessionIds.has(sessionId),
});
for (const item of stale) await item.remove();
```

A running VM is never stale, and `remove()` skips a VM something started since it was found. Set `idleTimeoutSecs`, so a VM stops soon after its last command and its record says when that was. Templates aren't reaped; see below.

### Which sessions are live

eve can't list its sessions, so only your agent knows which ones are live, and `isSessionLive` is how it says so. It takes a session id and returns a boolean or a promise of one. A VM whose session it reports live is never found stale, however long ago the VM was last used. A VM whose session it reports not live is found stale once it's also unused past `unusedForMs`. How your agent knows a session is live is yours to decide, for example a timestamp it stores for the session on every turn. If `isSessionLive` throws or rejects, `staleSandboxState` does too, and returns nothing to remove.

The id it's asked about is the one eve gives the provider as `SandboxSessionContext.session.id`, which is the id eve says to name a sandbox from:

- For a session with its own sandbox, it's that session's id.
- For a subagent that shares its parent's sandbox, it's the parent's id. Mark the parent live for as long as any of its subagents is.
- For a keyed `invokeTool` call, eve passes a derived tool-session id. This provider doesn't keep sandboxes for those (see `toolSessions` above), so `isSessionLive` isn't asked about one.

The provider knows a VM's session because `start` and `resume` record it, in one small file per VM under `eve-plus-sessions/` in `MSB_HOME`. microsandbox 0.7.10 can't label a VM when it restores one from a snapshot, so the record sits beside microsandbox's state instead of on the VM. `onSessionEnd` and `remove()` delete the record with the VM. If the record can't be written, the session carries on and that VM goes by its last use alone until the next `start` or `resume` writes it. `isSessionLive` is asked about every recorded VM in `MSB_HOME` that is past the cutoff, so if several agents share one `MSB_HOME`, it has to answer for all of their sessions.

### What still goes by last use

Two cases fall back to last use alone, where a VM unused past `unusedForMs` is found stale whether or not its session is live:

- **Without `isSessionLive`.** `staleSandboxState({ unusedForMs })` behaves as it did in 0.3.3.
- **A VM with no readable record of its session.** A VM created by 0.3.3 or earlier has none until its session next uses the sandbox, so after an upgrade a live session that never touches its sandbox again stays in this case. A VM whose record could not be written when it started or resumed, or whose record can no longer be read, is in it too: the provider doesn't fail the session over the record, and writes it again at the next start or resume.

Last use is a weak sign of a live session. Before eve 1.0.0-rc.11 every turn of a session resumed its VM when it started, so any turn counted as use. On 1.0.0-rc.11 and later only a tool or file operation that needs the sandbox resumes it, so a live session that doesn't use its sandbox looks unused. For these two cases, set `unusedForMs` longer than the longest stretch a live session is expected to go without using its sandbox. Removing a live session's VM loses that VM's files: eve's resume finds it gone and the session continues in a fresh sandbox.

## Pruning templates

Each distinct template key leaves one snapshot named `eve-plus-tpl-<key>` in `MSB_HOME`, and nothing removes old ones automatically. A session never depends on its template after its VM is restored, so removing a snapshot can't break a live or stopped session. Removing the snapshot that the current deployment's artifact names makes new sessions fail with `SandboxTemplateNotProvisionedError` until the next `eve build`.

To prune, remove snapshots whose key isn't the current deployment's, by digest, without `force`:

```ts
import { Snapshot } from "microsandbox";

const current = "eve-plus-tpl-<current template key>";
for (const snapshot of await Snapshot.list()) {
  if (snapshot.name?.startsWith("eve-plus-tpl-") && snapshot.name !== current) {
    await Snapshot.remove(snapshot.digest);
  }
}
```

## Testing

- **Unit tests** (`npm test`) cover the policy table, the lifecycle against an in-memory microsandbox, which VMs the reaper finds for live and ended sessions, that an abort kills a running command, the version pin, and a rule that shipped `src/` imports only eve's public package exports. One test is exempt from that rule: the state round-trip test imports eve's internal persisted-state resolution (`dist/src/sandbox/state.js`), because no public export reaches it, and it proves eve resumes this provider's recorded state.
- **The real-VM proof** (`integration/`, run with `vitest.integration.config.ts`, never by `npm test`) needs a KVM host with Docker and a live network, by necessity: it pulls images and probes real hosts. It runs every lifecycle, connection, network, rejection, runtime and persistence probe against a real microVM, as one vitest test per probe. `integration/proof.sh <repo>` runs it from an eve-plus checkout at the commit under test: it builds and packs this package, installs it with the eve, `ai` and vitest versions its `devDependencies` name, and runs the probes. It expects to run inside a throwaway container with an eve agent's posture: `node:24-trixie-slim`, non-root with the kvm group, only `/dev/kvm`, default AppArmor and seccomp, a fresh `MSB_HOME`, and the host CA bundle mounted read-only for the host-side msb runtime's image pulls.

## License

MIT, except `src/process.ts`, which is derived from eve's Apache-2.0 microsandbox provider. See `LICENSE-APACHE` and `NOTICE`.
