# @eve-plus/commissioning

An eve extension for durable commissioning: a verified commissioner defines work, a fixed authenticated worker reports progress and asks bounded questions, and the commissioner explicitly answers or reviews an immutable proposal. SQLite persists the specification, decisions, cursor history, commissioner context, and notification outbox.

The package uses published eve's `defineExtension`, tools, a queued channel, and handler schedules. Worker MCP uses the official SDK's stateless JSON Streamable HTTP transport on the eve channel route. There is no separate HTTP server.

## Mount

Install the package alongside eve, then create `agent/extensions/commissioning.ts`:

```ts
import commissioning from "@eve-plus/commissioning";
import { authenticateBuilder, resolvePrincipal, deliveryAuth } from "../lib/estate-identity.js";

export default commissioning({
  dataDir: "/var/lib/my-agent",
  namespace: "commissioning",
  workerPrincipalId: "estate:builder",
  authenticateWorker: authenticateBuilder,
  resolveSessionPrincipal: resolvePrincipal,
  resolveDeliveryAuth: deliveryAuth,
});
```

These three callbacks are trusted host code. `authenticateWorker(Request)` validates the estate's existing credential and returns `{ verified: true, principalId }` or `null`. Its principal must match `workerPrincipalId`; even a successfully authenticated owner credential is denied at the worker endpoint. `resolveSessionPrincipal(auth)` validates eve session identity and returns the same minimal caller shape. A consuming agent may map its admitted callers to a stable commissioner authority, while preserving the actual initiator privately. Explicitly exclude the configured worker and its native channel identities from that owner mapping. `resolveDeliveryAuth(principalId)` supplies a current eve auth context whose verified host mapping resolves to that commissioner; its raw transport principal may differ. Resolve and rotate credentials through the estate's existing secret provider. Do not return credentials as attributes or include them in errors.

The mount contributes `commissioning__open`, `commissioning__read`, `commissioning__decide`, a channel at `/commissioning/mcp`, and the `commissioning__reconcile` handler schedule. Mount filenames set tool and schedule prefixes; route paths remain literal. Use a unique namespace and MCP path for each mount.

## Workflow

1. A verified commissioner calls `open` with `{ spec: { brief, acceptance, privateGuidance? } }`. The host assigns a stable commission ID from the eve session and tool call, fixes the worker, and captures the commissioner's original textual conversation snapshot. No model argument can select an owner.
2. The worker authenticates and calls MCP `commission_read`, `commission_consult`, and `commission_report`. Worker views omit private guidance and commissioner context. `commission_read` takes `{ commissionId, after? }` and returns durable events with a new cursor. Poll this tool to discover answers and revision requests.
3. Questions, proposals, failures, and overdue checkpoints enter a transactional owner outbox. The channel dispatches them through one queued continuation per commission. The original commissioner history seeds that continuation once.
4. The commissioner calls `decide` to answer a question or accept/request revision of the exact proposal ID. Both the verified current owner and a trusted session binding are checked. Final response text, JSON, worker content, and guessed commission IDs cannot create decision authority.

A proposal identifies a repository, full 40-character commit, and pull request URL. Reviewed, merged, and deployed observations name that proposal ID. Acceptance and delivery are separate facets: acceptance can coexist with the later reviewed/merged/deployed observations. A failure means work remains blocked and alerts the owner; a later checkpoint records that active work resumed. Pending questions and proposal review remain independently visible.

The consuming estate owns acceptance timing, human escalation, and merge/deployment policy. For an estate that accepts after merge, instruct its commissioner to verify the merged artifact before accepting. Proposal review does not introduce a new merge gate. This package does not automatically wake, resume, cancel, or restart Cyrus. Worker answers are discoverable through durable MCP polling.

Trusted host adapters can pass a fifth `OpenOptions` argument to `store.open`: `{ requestWorkerActivation: true }`. The default and `false` preserve the existing behavior. `true` atomically records the commission and one owner-duty `worker_activation_requested` event/outbox entry, whose public payload contains only `commissionId`. The host dispatcher must intercept that entry, perform a supported activation operation, reconcile uncertain outcomes before retrying, and acknowledge only a confirmed handoff. The receipt means activation was requested; it does not prove the worker started or provide automatic resume. Build the external contract from the worker projection, never from the owner delivery packet or private context.

## Configuration and operations

| Setting | Meaning |
| --- | --- |
| `dataDir` | Required absolute durable application data directory, outside sandbox and ephemeral deployment output. |
| `namespace` | Required unique lowercase mount name, up to 64 characters. |
| `workerPrincipalId` | Required fixed principal validated on every worker request. |
| `authenticateWorker` | Required verified request-to-worker resolver. |
| `resolveSessionPrincipal` | Required verified eve-auth-to-caller resolver. |
| `resolveDeliveryAuth` | Required current principal-to-eve-auth resolver for owner notification. |
| `captureSource` | Optional synchronous host callback receiving `ToolContext`, returning only whitelisted non-secret native conversation coordinates. These stay private with the original context. |
| `overdueAfterMs` | Optional positive checkpoint interval; default one minute. |
| `reconcileCron` | Optional native handler cron; default every minute. The consuming estate owns maintenance windows. |
| `mcpPath` | Optional unique channel route; default `/commissioning/mcp`. |

Run one eve host process per mount and data directory, on a local filesystem that supports SQLite WAL. Enforce this deployment constraint with one container/process and its durable volume. Do not use shared multi-host storage or horizontal replicas. Back up the SQLite database with the WAL-aware SQLite backup mechanism or stop the host before copying its files. The original owner conversation snapshot is private durable data; apply the estate's normal data retention and filesystem access policy.

The handler schedule checks overdue work, leases pending owner notifications, and awaits native channel delivery before marking them delivered. A route operation can reconcile immediately as well. Empty sweeps create no model turns. `eve dev` does not fire cron automatically; production must run eve's supported schedule runner, normally `eve build && eve start`. See [operations and recovery](docs/operations.md).

Retry question IDs and event IDs with identical content. Changed reuse conflicts. SQLite commits before notification. Dispatch retries reuse stable eve idempotency keys; eve retains only its recent 1,024 keys per session, so recovery does not guarantee exactly-once model execution after resets, replacement, or retention eviction. Ledger decisions and worker events remain idempotent independently.

Owner reads include `notification` diagnostics: pending receipt count, durable attempt count, last attempt time, and a fixed `identity_unavailable` or `dispatch_failed` class. No raw exception is persisted. `currentProposal` always includes the current immutable artifact and summary, even when the cursor page contains only older events. Worker views omit owner notification diagnostics.

For an estate that needs human clarification, override both the contributed channel and schedule through eve's documented directory mount. The public `/transport` export includes `createDispatcher` and `OwnerDelivery`, including the private context for a trusted host adapter. Deliver to the original visible native conversation using its stored source and exact session ID; do not silently create an unbound replacement conversation. The package's default private owner continuation cannot itself display questions to a person on another channel.

After a native runtime reset, a consuming estate may provide an explicit operator recovery tool. Its host code must verify the actual operator and the same captured source, then call the host-only `store.rebindSession` with the expected active session, new session, stable receipt ID, and verified requester. Original context, source, and initiator stay immutable. Once a new active session is recorded, only that exact session can decide, even if an old session returns with stale durable state. The package does not expose a default recovery tool or permit automatic cross-conversation relocation.

## Build and test

```sh
pnpm build
pnpm typecheck
pnpm test
```

Build runs `eve extension build` and emits public ledger/transport declarations. `better-sqlite3` is declared as an eve external dependency so its native package layout survives the consuming build. The extension is authored against eve `0.83.2`; generated compatibility metadata determines runtime compatibility. Node 24 or newer is required.

Deterministic tests cover the ledger, restart/outbox recovery, official MCP client transport, fixed-worker authentication, rejected owner operations, privacy, retry identity, and owner notification failure. No paid or live-model calls run in these tests. Runtime deployment validation belongs on the intended eve host after independent package review; see [the validation guide](docs/validation.md).
