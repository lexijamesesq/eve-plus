# Operations and recovery

The application owns `<dataDir>/<namespace>/commissions.sqlite` and persistent eve Workflow World. Preserve both across deployments. Use one process/local volume per mount, outside worker sandbox and ephemeral output. Back up with SQLite's WAL-aware mechanism or stop the process before copying database files.

## Delivery and identity

Mutations commit before owner notification. Dispatch leases pending entries and acknowledges after delivery. A crash after send and before acknowledgement can repeat dispatch. Stable eve keys suppress repeats only within the recent-key window; a World/session reset or key eviction can produce another owner turn. Durable ledger IDs independently prevent repeated canonical decisions/reports. Do not claim exactly-once model execution.

Default delivery seeds a separate commissioner continuation once and queues later notifications. It does not display questions in an external human conversation. Applications needing that behavior use supported eve channel composition with verified source/session mapping. Preserve ownership, queued delivery and retry keys; a missing original session is not permission to create an unbound replacement.

Native progress rendering is another output surface: serializing full tool arguments can expose `privateGuidance` even when worker views are redacted. Configure the channel's documented rendering events and inspect actual outgoing activities. The core cannot sanitize arbitrary model/application prose after publication.

Failed identity or delivery leaves work pending. Owner reads expose attempts, pending count, last-attempt time and fixed safe failure classes; worker reads omit them. Restore the application's configuration and reconcile. Raw callback/provider errors and credentials are not diagnostics. MCP reads do not invoke reconciliation or wait for unrelated owner sends. Native mutation routes hand reconciliation to Eve's official `waitUntil`; cron remains the durable retry path. A direct low-level transport `reconcile` callback is still awaited after mutations.

Each dispatcher sweep snapshots at most 100 eligible sequence IDs ordered by durable attempt count then sequence. It conditionally takes a fresh lease immediately before each send. Competing claims or completed entries are skipped, and each selected entry is attempted at most once in that sweep. Retry order survives restart; this is bounded fairness, not a delivery-time guarantee when callbacks or provider requests are unavailable.

Overdue grace and deduplication use the latest worker activity or commissioner hand-back (`max(updated, heartbeat)`). `heartbeat` and `lastWorkerActivity` retain their worker-only meaning; `activityEpoch` identifies the grace window. Answering a question or requesting revision grants a full new interval. Requested revisions can become overdue; pending questions/review, blocked and accepted work cannot. Session recovery does not advance this activity clock.

## Connector handoff

A selected connector prepares its target read-only. Commission, immutable binding and activation intent then commit together. Both MCP and handler cron use the same activation dispatcher before ordinary owner delivery. Applications do not write a second activation engine.

Handoff uses persisted target and worker-redacted spec. Confirmed handoff is separate from execution start. Read back uncertain outcomes before retrying. Observed conflicts or configuration drift stay pending; investigate without overwriting another assignment. The [Cyrus guide](cyrus.md) defines service-specific behavior.

Host-only `store.open(..., context, {requestWorkerActivation: true})` remains available for integrations that explicitly install their own handler. Do not request activation without handling it or serialize a private owner packet into an external contract.

Drain existing manually handled activation entries before opting that mount into a connector. A selected connector cannot infer a missing immutable binding for an old entry: it leaves the entry pending rather than routing it through a legacy handler or guessing a target. An absent connector with no stored binding preserves explicit legacy handling.

The candidate adds a versioned worker-binding table. Migration to schema 3 is transactional and preserves prior commissions; older code that does not understand schema 3 must refuse it. Keep a WAL-aware backup before upgrading. A code rollback alone is not a database downgrade, and deleting the ledger is not recovery.

## Session and worker recovery

A host may expose operator recovery. Authenticate and authorize the requester, verify the exact original source and read the expected active session. In that authenticated channel's official `from` context, reset/create the canonical commission address before recording its actual returned session ID:

```ts
const source = from(commissionId);
await source.reset({ reason: "Authorized commissioner recovery" });
const { session } = await source.create({ auth: replacementAuth, history: trustedHistory });
store.rebindSession(owner, {
  commissionId,
  eventId: recoveryReceiptId,
  expectedActiveSessionId,
  activeSessionId: session.id,
  source: originalSource,
}, requestedBy);
```

The application derives all identities, history and source from trusted host state. The reset/create and ledger CAS are separate native operations: serialize authorized recovery, retain the receipt and inspect both states after an interrupted or conflicting recovery. Default delivery checks `create().session.id` against the explicit active pointer before sending or acknowledging. An unrelated replacement session is not a supported routing destination; a mismatched address leaves delivery pending. Source/history/initiator remain immutable, and restored prior sessions lose decision authority. Worker prose cannot authorize recovery.

A stopped, cancelled or blocked worker differs from a missing checkpoint. Inspect its durable work and supported session state. Use the selected connector's continuation procedure, retaining commission/question/proposal IDs. The neutral core has no worker restart or automatic resumption API.

Applications define merge, deployment and acceptance policy. Proposal evidence, delivery observations and acceptance remain distinct. A newly recorded reviewed/merged/deployed observation for the current pending proposal notifies the owner for reconsideration; the application independently verifies the claim before any explicit acceptance. Replaying the event, repeating an observation kind under a new event ID, or reporting after acceptance does not create another owner notification.
