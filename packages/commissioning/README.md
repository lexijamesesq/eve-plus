# @eve-plus/commissioning

Durable software commissioning for [eve](https://github.com/vercel/eve), with a worker-neutral core and an optional, included Cyrus connector. A commissioner defines work, an authenticated worker asks questions and proposes an immutable Git artifact, and the commissioner explicitly answers, accepts or requests revision.

Corrected lifecycle and handoff behavior has passed installed-consumer and isolated native qualification with synthetic services. Live credentials, service intake and deployment require qualification in the consuming application.

## Install and try

Use Node 24 and the repository's pinned pnpm. From an eve-plus checkout:

```sh
pnpm install --frozen-lockfile
pnpm --filter @eve-plus/commissioning run build
pnpm --dir packages/commissioning pack --pack-destination /tmp/commissioning-package
```

Install the resulting tarball alongside published `eve@0.83.2` in your own project. The complete [Cyrus consumer](examples/cyrus/README.md) supplies its own identity adapter and selects the real connector. Qualification supplies synthetic external responses; ordinary configured use calls the real service. It imports no private application.

This repository distributes packages through Git release tags. For the release containing the clean-install correction, use:

```json
{
  "dependencies": {
    "@eve-plus/commissioning": "github:lexijamesesq/eve-plus#commissioning--v0.1.1&path:packages/commissioning",
    "eve": "0.83.2"
  }
}
```

The tag becomes available through the normal release workflow after merge. Local tarballs remain the prerelease review path. Version 0.1.0 can fail during a clean pnpm Git install because its workspace permits an unnecessary native rebuild; use 0.1.1 or newer for that installation path.

## Select a worker

Select the public Cyrus module in an ordinary mount. It supplies actual supported Linear handoff and reconciliation; the application does not implement a replacement open tool, dispatcher or scheduler:

```ts title="agent/extensions/commissioning.ts"
import commissioning from "@eve-plus/commissioning";
import { cyrus } from "@eve-plus/commissioning/cyrus";
import { identity, getLinearAccessToken } from "../lib/identity.js";

export default commissioning({
  ...identity,
  dataDir: "/var/lib/my-agent",
  namespace: "commissions",
  worker: cyrus({
    linear: { accessToken: getLinearAccessToken },
    delegateId: "your-cyrus-linear-user-id",
    mcp: {
      serverName: "commissioner",
      endpoint: "https://agent.example/commissioning/mcp",
    },
  }),
});
```

The [reference consumer](examples/cyrus/README.md) includes a complete identity adapter, including its matching `workerPrincipalId`. Keep that configured principal consistent with the identity returned by worker authentication. The three trusted callbacks below are application-owned authentication, not hidden dependencies. Actual credentials, delegate IDs, destinations and acceptance policy remain your configuration.

The mounted open tool accepts:

```json
{
  "spec": {
    "brief": "Implement the requested change",
    "acceptance": ["The agreed behavior is verified"],
    "privateGuidance": "Owner-only review notes"
  },
  "workReference": { "kind": "linear-issue", "id": "ENG-123" }
}
```

The connector resolves the issue and persists its canonical binding with the commission and activation intent. Shared dispatch preserves the issue's existing work criteria, appends a worker-redacted contract, delegates and confirms by readback. A lost response is reconciled before retrying. **Confirmed handoff does not prove Cyrus started.** See [Cyrus setup and lifecycle](docs/cyrus.md).

Omit `worker` for the neutral protocol. That mode requires no Cyrus configuration and makes no Cyrus/Linear service calls. It does not launch a worker: the application hands its commission ID and worker-visible specification to an existing worker integration.

## Commissioning loop

1. Native `commissioning__open` records the verified commissioner, textual history and specification. Model arguments never select owner identity.
2. The fixed worker authenticates to `/commissioning/mcp` and uses `commission_read`, `commission_consult` and `commission_report`.
3. Questions, proposals, failures, relevant new delivery observations and overdue attention enter the durable owner outbox. Default delivery creates a separate queued commissioner continuation per commission, seeded from the original history.
4. Native `commissioning__decide` explicitly answers a question or accepts/requests revision of its exact proposal ID. Final prose or JSON never records a decision. Workers poll MCP read for the recorded answer/verdict.

Proposals require a credential-free HTTPS repository URL, full lowercase 40-hex Git commit and matching GitHub/GitLab-shaped PR URL. This version supports software proposals, not arbitrary document/research artifacts. Reviewed, merged and deployed reports are observations; acceptance is a separate decision. The application defines acceptance timing.

## Configuration

| Setting | Responsibility |
| --- | --- |
| `dataDir` | Absolute durable local storage, outside sandbox and deployment output. |
| `namespace` | Unique lowercase storage namespace, up to 64 characters. |
| `workerPrincipalId` | Fixed authenticated worker for the mount. |
| `authenticateWorker(request)` | Return a host-verified worker principal or `null`. A verified owner credential is still denied at the worker endpoint. |
| `resolveSessionPrincipal(auth)` | Validate native identity and map to commissioner authority; exclude the worker. |
| `resolveDeliveryAuth(principalId)` | Supply current eve auth that maps back to the commissioner. |
| `worker` | Optional connector, such as `cyrus(...)`; selected connectors require a work reference on open. |
| `captureSource(ctx)` | Optional trusted capture of bounded, non-secret conversation coordinates, kept private. |
| `overdueAfterMs` | Worker grace interval after activity or commissioner hand-back, default one minute. |
| `reconcileCron` | Native handler cron, default every minute. Application maintenance policy remains external. |
| `mcpPath` | Unique literal route, default `/commissioning/mcp`; mount filenames namespace tools, not routes. |

Identity resolvers return `{verified: true, principalId}` or `null`. Never put credentials in attributes, references, model arguments or errors. Worker projections omit owner guidance, source, initiator and conversation history. Connector handoff receives only its prepared binding and worker-visible specification.

## Integration boundaries

- Uses published eve extension/tools/channel/schedule/state APIs and the official MCP SDK; no separate server or private runtime imports.
- One worker and one eve process per mount with persistent local SQLite/WAL is the supported topology. This is a package constraint, not an eve-wide requirement; horizontal replicas/shared multi-host storage are unsupported.
- Default owner continuations are private agent conversations. Human-visible routing is an application integration. Native progress renderers must not publish private tool arguments; see [operations](docs/operations.md).
- Explicit recovery is host-authorized: verify the requester and original source, reset/create the canonical commission address, then CAS-rebind to that actual session ID with `store.rebindSession`. Delivery refuses a different current address owner. Original context stays immutable and old-session authority is revoked. See the [recovery recipe](docs/operations.md#session-and-worker-recovery).
- `.` and `./tools` use eve-generated `.mjs`/`default` exports; `./store`, `./transport`, `./config` and `./cyrus` expose typed host APIs. Wildcard eve peer plus generated compatibility metadata follow the official extension scaffold. The qualification target is exactly eve 0.83.2, not every future runtime.

## Validation and known limitations

See the [validation guide](docs/validation.md) for routine tests, clean packaged-consumer checks, native eve evidence and released-Cyrus conformance. Synthetic services do not prove real credentials, webhook intake or worker execution start.

Dispatch snapshots at most 100 eligible entries by durable attempt count and sequence, then claims each immediately before sending. Failed work is attempted once per sweep; later unattempted work can progress across retries and restart. Working and revision-requested commissions get overdue attention only after a full grace interval following worker activity or commissioner hand-back. Pending questions/review, blocked and accepted work do not get that attention.

Worker reads do not trigger reconciliation. Mutations commit first; the native route tracks their subsequent reconciliation through Eve's `waitUntil`, and cron retries pending work. Low-level callers supplying `reconcile` directly retain its awaited callback semantics. A newly recorded current-proposal delivery observation can notify a pending reviewer; duplicate observations and accepted work do not cause repeated review turns. Acceptance remains an explicit commissioner decision after application verification.

This public-consumer increment does not certify production deployment, live-model judgment, arbitrary identity adapters or a complete security/performance audit. See [operations and recovery](docs/operations.md) before adopting the candidate.
