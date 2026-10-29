# A standalone commissioning consumer

This application mounts the installed public package's ordinary tools, channel
and schedule. Cyrus mode selects the real public connector. Its identity adapter
is a small local demonstration using Eve's HTTP Basic verifier for the owner and
a separate worker Bearer credential, or the optional signed-worker configuration below. Its deterministic `eve/evals` model opens a
commission, answers through the decide tool, and reviews a committed acceptance
marker without a paid model request; select your own model and acceptance
policy for real work.

Use Node 24. Copy this entire directory outside the source repository. Install
the local candidate tarball produced by `pnpm --filter @eve-plus/commissioning
pack --pack-destination /absolute/scratch`, then install the example's declared
dependencies:

Replace `PACKED_TARBALL.tgz` below with the exact filename printed by `pack`.

```sh
npm install /absolute/scratch/PACKED_TARBALL.tgz
npm run typecheck
```

For a future published release, replace the tarball with its reviewed public
package version. This example does not assume a release/tag already exists.

Set these environment variables before both build and runtime:

| Variable | Value |
| --- | --- |
| `EXAMPLE_DATA_DIR` | Absolute durable local application directory. |
| `EXAMPLE_OWNER_PASSWORD` | Local owner's password; do not reuse a worker credential. |
| `EXAMPLE_WORKER_TOKEN` | Bearer mode: worker endpoint credential, provided privately. |
| `EXAMPLE_WORKER_AUTH` | `bearer` (default) or explicit `signed` mode below. |
| `EXAMPLE_WORKER_ALGORITHM` | `ES256` (default) or explicit `EdDSA` for Ed25519, matched on server and worker. |
| `EXAMPLE_WORKER_MODE` | `cyrus` (default) or `neutral`. |
| `EXAMPLE_LINEAR_TOKEN` | Cyrus mode: token for the configured Linear workspace. |
| `EXAMPLE_CYRUS_DELEGATE_ID` | Cyrus mode: explicit enrolled Cyrus delegate ID. |
| `EXAMPLE_MCP_ENDPOINT` | Cyrus mode: reachable full `/commissioning/mcp` URL. |
| `EXAMPLE_ARTIFACT_REPOSITORY` | Proposal inspection: allowlisted public repository URL. |
| `EXAMPLE_GIT_DIR` | Proposal inspection: local checkout containing proposed full commits. |

```sh
npm run build
npm start
```

Send an HTTP Basic authenticated POST to `/example/message` with JSON
`{"message":"OPEN ENG-123"}`. The username is `example-commissioner` and the
password is `EXAMPLE_OWNER_PASSWORD`. The returned native session ID can be read
through Eve's authenticated session API. Opening in Cyrus mode performs only
read-only preparation; the native reconcile schedule confirms the handoff.
The connector preserves the existing issue description and delegates the work
only after recording its worker-safe contract. Use a disposable work issue when
trying a real integration: Cyrus mode uses the actual Linear API.

Neutral mode needs none of the three Cyrus configuration variables. Send
`{"message":"OPEN"}`; it records the commission without requesting activation.
The application must hand the resulting ID/specification to its chosen worker.

The demonstration commissioner answers questions with its recorded acceptance
criteria. For proposals, its `inspect` tool reads `acceptance.txt` from the exact
reported full commit in `EXAMPLE_GIT_DIR`; a value of `ready` accepts and other
values request revision. An absent/unallowlisted repository fails inspection.
This narrow teaching policy is not a general acceptance policy or merge gate.

## Worker connection

For a manual MCP read, use the returned commission ID:

```sh
npm run worker -- COMMISSION_ID
```

For Cyrus, create a private file containing the worker token, set
`EXAMPLE_WORKER_CREDENTIAL_FILE` to its absolute path, and run
`npm run worker:artifacts`. This uses the actual public artifacts API to write
`mcp.json`, `worker-allowed-tools.json` and `worker-instructions.md`. Configuration
contains the executable helper path and endpoint, never the resolved token. The
helper reads its adjacent generated settings file, validates the native SDK's
server name and URL through the public API, then reads the credential file.

For the public `ClaudeRunner` API, retain your authenticated native Linear MCP
configuration alongside the generated file:

```ts
mcpConfigPath: [nativeLinearMcpConfigPath, generatedMcpConfigPath]
```

The generated `mcp.json` supplies only the commissioning server. Contract
discovery also needs the existing native Linear comment-reading tools, including
when the initial issue prompt omits comments. Provide a reviewed complete
`allowedTools` policy retaining that native access and the generated three exact
commissioning tool names, and append the generated instructions to `systemPrompt`.
Use tool discovery for the native comment tool's current input schema. The public
probe demonstrates this direct runner composition against its pinned release,
with a synthetic Linear peer. For daemon
configuration, follow the [package's Cyrus guide](../../docs/cyrus.md): repository selection and
instruction fields differ. Preserve existing restrictions and never materialize
or widen inherited policy automatically. Credentials, service configuration and lifecycle remain
application responsibilities. A confirmed delegation does not prove a worker
turn started; see the package's Cyrus documentation for supported manual
continuation after the worker parks.

The public qualification harness stages this same application with synthetic
external HTTP responses. Test-only routes and fault controls live under `tests`,
not in this example. No private repository or global Cyrus installation is needed.

## Signed worker mode

The default example retains its existing opaque bearer callback. To explicitly select the optional
public signer/verifier, set `EXAMPLE_WORKER_AUTH=signed` for the Eve application and artifact generator.
On Eve, supply `EXAMPLE_WORKER_ISSUER`, `EXAMPLE_MCP_ENDPOINT` and
`EXAMPLE_WORKER_PUBLIC_KEY_FILE` pointing to the dedicated worker's SPKI public key. The worker subject
is the example's existing `example:builder`. No worker private key or token is required on Eve in this mode.

For `scripts/worker-artifacts.mjs`, supply the same issuer and endpoint plus
`EXAMPLE_WORKER_PRIVATE_KEY_FILE` pointing to a dedicated PKCS8 key matching the selected algorithm under your worker's custody.
Generated settings contain its path, not key material. The native headers helper reads that key and uses
`createSignedWorkerCredential`; replace the example file reader with your existing custody provider as
needed. Do not pass a live key or token into a model, ordinary environment variable or MCP JSON.
Invalid signed configuration fails; it never falls back to the bearer mode. The example uses the helpers'
300-second lifetime/maximum and 30-second skew defaults. See the package's
[authentication policy and rotation guidance](../../README.md#optional-signed-worker-authentication).
