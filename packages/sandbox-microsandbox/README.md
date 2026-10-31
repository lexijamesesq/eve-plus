# Eve-Plus Sandbox: microsandbox

A sandbox provider for [eve](https://github.com/vercel/eve) that runs each session in its own [microsandbox](https://github.com/superradcompany/microsandbox) microVM, deny-all by default. It's built on eve's public `defineSandboxProvider` seam (`eve/sandbox/provider`) and uses no eve internals, so an eve release that keeps that seam can't break it.

## Install

Install it from a release tag as a git dependency, next to eve 0.91.0 or later within 0.91:

```json
{
  "dependencies": {
    "@eve-plus/sandbox-microsandbox": "github:lexijamesesq/eve-plus#sandbox-microsandbox--v0.2.0&path:packages/sandbox-microsandbox",
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

| Option      | Default                                | Meaning                                                               |
| ----------- | -------------------------------------- | --------------------------------------------------------------------- |
| `image`     | `debian:trixie-slim`, pinned by digest | Base OCI image. It must be pinned (`name@sha256:…`) and provide bash. |
| `cpus`      | `1`                                    | vCPUs per sandbox.                                                    |
| `memoryMib` | `1024`                                 | Memory per sandbox, in MiB.                                           |
| `prepare`   | none                                   | eve's standard template setup, run once per template.                 |

`open()` takes `{ networkPolicy }`, described below. There's no idle or maximum-duration auto-stop: a sandbox runs until eve stops it or the session ends.

## How it works

- **`prepare`** (at `eve build`) boots a template VM from the image, fails clearly if the image lacks bash, creates `/workspace` as root (as eve's Docker provider does), and runs `ctx.populate()`, which seeds workspace and skill files and runs your `prepare`. It then stops the VM and captures a disk snapshot named for the template key, which hashes the image, the microsandbox version, and eve's workspace, skill and sandbox-file inputs. An unchanged template is reused. The template build runs `allow-all`, so your `prepare` can install packages. A failed build removes its VM and any snapshot it captured.
- **`start`** finds the session's VM by a name derived from the session id and the app's sandbox storage path. It connects to a running VM, boots a stopped one, or restores a new one from the template snapshot under the session's network policy, always detached. Concurrent and cross-process starts converge on one VM. A missing template snapshot throws eve's `SandboxTemplateNotProvisionedError`, and a policy that would weaken the existing VM's throws `NetworkPolicyConflictError` (see below).
- **`resume`** reconnects to the recorded VM, booting it if it's stopped, or throws `SandboxSessionGoneError` if it no longer exists.
- **`onSessionEnd`** deletes the VM. It's idempotent and succeeds when nothing exists.
- **Commands** run as `bash -lc` with eve's `SANDBOX_AGENT_ENV` beneath the per-call environment, because a VM restored from a snapshot doesn't keep the template's environment. Aborting a command kills its whole process tree, including backgrounded children.

The recorded session state is `{ sandboxName, msbVersion }` under `stateProtocolVersion` 1, and the provider's name is `eve-plus-microsandbox`. eve discards state recorded under the name `microsandbox`, which belonged to the provider eve 0.83 removed.

`toolSessions` is omitted: a keyed `invokeTool` call that requests a sandbox fails, because nothing would bound how long its VM lives.

## Network policy

The provider enforces exactly two policies, set once when a session's sandbox is created. Every other shape rejects with `UnsupportedNetworkPolicyError` rather than being weakened: microsandbox can't inject the headers eve's `transform` rules add, and can't change a live sandbox's policy.

An absent policy means `deny-all`. eve's Docker provider defaults to `allow-all`; this one doesn't.

A sandbox keeps the policy it was created with. A later `open()` asking for `deny-all` when the session's sandbox was created `allow-all` throws `NetworkPolicyConflictError` instead of quietly handing back network access; delete the session's sandbox (`sandbox.delete()`) to start a fresh one. A later `open()` asking for `allow-all` when the sandbox is `deny-all` reconnects to it unchanged, since eve applies open options only when a sandbox is created.

No TLS interception is configured, and the guest trusts only its image's own certificate store.

The table below is checked by the package's unit tests: each row's shape is parsed as JSON and must produce its result.

| Shape                                                                                    | Result      |
| ---------------------------------------------------------------------------------------- | ----------- |
| absent                                                                                   | `deny-all`  |
| `"deny-all"`                                                                             | `deny-all`  |
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

- **Unit tests** (`npm test`) cover the policy table, the lifecycle against an in-memory microsandbox, that an abort kills a running command, the version pin, and a rule that shipped `src/` imports only eve's public package exports. One test is exempt from that rule: the state round-trip test imports eve's internal persisted-state resolution (`dist/src/sandbox/state.js`), because no public export reaches it, and it proves eve resumes this provider's recorded state.
- **The real-VM proof** (`integration/`, run with `vitest.integration.config.ts`, never by `npm test`) needs a KVM host with Docker and a live network, by necessity: it pulls images and probes real hosts. It runs every lifecycle, connection, network, rejection, runtime and persistence probe against a real microVM, as one vitest test per probe. `integration/proof.sh <repo>` runs it from an eve-plus checkout at the commit under test: it builds and packs this package, installs it with the eve, `ai` and vitest versions its `devDependencies` name, and runs the probes. It expects to run inside a throwaway container with an eve agent's posture: `node:24-trixie-slim`, non-root with the kvm group, only `/dev/kvm`, default AppArmor and seccomp, a fresh `MSB_HOME`, and the host CA bundle mounted read-only for the host-side msb runtime's image pulls. The estate runs it that way on its arm64 KVM host, for any commit or release tag, from a CI job that owns the container and its limits.

## License

MIT, except `src/process.ts`, which is derived from eve's Apache-2.0 microsandbox provider. See `LICENSE-APACHE` and `NOTICE`.
