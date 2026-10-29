# @eve-plus/commissioning

Durable software commissioning for [eve](https://github.com/vercel/eve), with a worker-neutral core and an optional, included Cyrus connector. A commissioner defines work, an authenticated worker asks questions and proposes an immutable Git artifact, and the commissioner explicitly answers, accepts or requests revision.

Version **0.3.0** adds optional signed worker credentials and authentication. Existing authentication callbacks and the strict owner-session default remain available unchanged. Local qualification uses synthetic services; it does not certify live service credentials or production operation.

## Install and try

Use Node 24 and the repository's pinned pnpm. From an eve-plus checkout:

```sh
pnpm install --frozen-lockfile
pnpm --filter @eve-plus/commissioning run build
pnpm --dir packages/commissioning pack --pack-destination /tmp/commissioning-package
```

Install the resulting tarball alongside published `eve@0.83.2` in your own project. The complete [Cyrus consumer](examples/cyrus/README.md) supplies its own identity adapter and selects the real connector. Qualification supplies synthetic external responses; ordinary configured use calls the real service. It imports no private application.

This repository distributes packages through Git release tags. Choose an available tag from the [package releases](https://github.com/lexijamesesq/eve-plus/releases). For version 0.3.0, the dependency is:

```json
{
  "dependencies": {
    "@eve-plus/commissioning": "github:lexijamesesq/eve-plus#commissioning--v0.3.0&path:packages/commissioning",
    "eve": "0.83.2"
  }
}
```

Use that dependency only after its tag appears in the releases. The normal main-branch workflow publishes package tags; use the tarball above to evaluate a checkout whose version is not yet released. Version 0.1.0 can fail during a clean pnpm Git install because its workspace permits an unnecessary native rebuild; use 0.1.1 or newer for that installation path.

## Optional signed worker authentication

Select `@eve-plus/commissioning/auth` when short-lived ES256 worker tokens fit your integration.
This is explicit configuration: omitting this helper preserves your existing authentication callback;
there is no switch that turns authentication into anonymous access. It uses Eve's public
`extractBearerToken` and `verifyJwtEcdsa` APIs, qualified with `eve@0.83.2`; an Eve version providing
those APIs is required. This mode requires no authorization server or shared verifier secret.

```ts
import { createSignedWorkerAuthenticator, createSignedWorkerCredential } from "@eve-plus/commissioning/auth";

// Server: only public SPKI PEM trust, never the worker's private key.
const authenticateWorker = createSignedWorkerAuthenticator({
  issuer: "urn:example:worker", subject: "worker:builder",
  audience: "https://agent.example/commissioning/mcp", publicKeys: trustedPublicKeys,
  maxLifetimeSeconds: 300, clockToleranceSeconds: 30,
});
// Assign this callback to CommissioningConfig.authenticateWorker and set
// workerPrincipalId to the same exact subject. It grants worker tools only.

// Worker: supply your existing custody resolver, without changing its scope.
const resolveCredential = createSignedWorkerCredential({
  issuer: "urn:example:worker", subject: "worker:builder", lifetimeSeconds: 300,
  resolvePrivateKey: ({ signal }) => custody.readDedicatedPkcs8Key({ signal }),
});
// For Cyrus, pass resolveCredential to runCyrusHeadersHelper alongside servers.
```

The signer derives audience only from its callback's endpoint; Cyrus's header helper validates the exact
configured server and URL before calling it. Other worker clients must establish the same destination
boundary before resolving key custody. No key or derived token is cached by these factories. Keep keys
and bearer values out of model arguments, MCP configuration JSON, logs and child environments.

The verifier requires `iat` and `exp`, bounds their difference by `maxLifetimeSeconds`, rejects future
issued-at beyond clock tolerance and delegates signature/issuer/audience/expiry checks to Eve.
Configured subject identity is literal, including `*`. Defaults are 300 seconds and 30 seconds of skew;
lifetimes must be positive finite numbers, and clock tolerance may be zero. Configure signer lifetime
no greater than the verifier maximum. Expiry can be accepted through the configured skew window.
Empty public trust denies every request. Invalid credentials produce the transport's existing 401.

For rotation, add new public trust, switch the worker's dedicated signer, wait the old token lifetime
plus tolerance, then remove old trust. Redeploy or reload consumers to apply new trust. A compromised
signing key remains usable until removed from trust; short token expiry alone does not revoke that key.
Use your existing private-key custody and revocation process. Never reuse unrelated service keys.
The [complete example](examples/cyrus/README.md#signed-worker-mode) shows this optional configuration.

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
| `authorizeOwnerSession({session, context})` | Optional synchronous host policy replacing session binding only for the verified stored owner. Requires captured source and explicit `true`; see [owner-session policy](docs/operations.md#optional-owner-session-policy). |
| `overdueAfterMs` | Worker grace interval after activity or commissioner hand-back, default one minute. |
| `reconcileCron` | Native handler cron, default every minute. Application maintenance policy remains external. |
| `mcpPath` | Unique literal route, default `/commissioning/mcp`; mount filenames namespace tools, not routes. |

Identity resolvers return `{verified: true, principalId}` or `null`. Never put credentials in attributes, references, model arguments or errors. Worker projections omit owner guidance, source, initiator and conversation history. Connector handoff receives only its prepared binding and worker-visible specification.

## Integration boundaries

- Uses published eve extension/tools/channel/schedule/state APIs and the official MCP SDK; no separate server or private runtime imports.
- One worker and one eve process per mount with persistent local SQLite/WAL is the supported topology. This is a package constraint, not an eve-wide requirement; horizontal replicas/shared multi-host storage are unsupported.
- Default owner continuations are private agent conversations. Human-visible routing is an application integration. Native progress renderers must not publish private tool arguments; see [operations](docs/operations.md).
- With the default strict session binding, explicit recovery is host-authorized: verify the requester and original source, reset/create the canonical commission address, then CAS-rebind to that actual session ID with `store.rebindSession`. Delivery refuses a different current address owner. Original context stays immutable and old-session authority is revoked. See the [recovery recipe](docs/operations.md#session-and-worker-recovery).
- `.` and `./tools` use eve-generated `.mjs`/`default` exports; `./store`, `./transport`, `./config`, `./cyrus` and optional `./auth` expose typed host APIs. Wildcard eve peer plus generated compatibility metadata follow the official extension scaffold. The qualification target is exactly eve 0.83.2, not every future runtime.

## Validation and known limitations

See the [validation guide](docs/validation.md) for routine tests, clean packaged-consumer checks, native eve evidence and released-Cyrus conformance. Synthetic services do not prove real credentials, webhook intake or worker execution start.

Dispatch snapshots at most 100 eligible entries by durable attempt count and sequence, then claims each immediately before sending. Failed work is attempted once per sweep; later unattempted work can progress across retries and restart. Working and revision-requested commissions get overdue attention only after a full grace interval following worker activity or commissioner hand-back. Pending questions/review, blocked and accepted work do not get that attention.

Worker reads do not trigger reconciliation. Mutations commit first; the native route tracks their subsequent reconciliation through Eve's `waitUntil`, and cron retries pending work. Low-level callers supplying `reconcile` directly retain its awaited callback semantics. A newly recorded current-proposal delivery observation can notify a pending reviewer; duplicate observations and accepted work do not cause repeated review turns. Acceptance remains an explicit commissioner decision after application verification.

This public-consumer increment does not certify production deployment, live-model judgment, arbitrary identity adapters or a complete security/performance audit. See [operations and recovery](docs/operations.md) before adopting the package.
