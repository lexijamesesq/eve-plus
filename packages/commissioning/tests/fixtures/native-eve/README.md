# Native qualification overlays

This directory is test controls, not another application. The canonical public
consumer is `examples/cyrus`, shipped inside the package. `tests/public-consumer.mjs`
installs a local tarball outside the monorepo, copies that installed example and
typechecks/builds its unchanged neutral and Cyrus configurations. It starts no
agent or model runtime.

After the candidate is reviewed, prepare that same stage on the isolated runtime
platform:

```sh
node tests/prepare-native.mjs /absolute/consumer-stage --install-cyrus
```

Preparation adds these overlays and builds; it does not start an agent. Its
neutral and Cyrus outputs come from two normal Eve builds of the same consumer;
the neutral build/runtime receive no Cyrus service configuration. A separate
native neutral case opens and reads through the authored tools and worker MCP,
then requires no binding, activation intent or synthetic service request.
Its synthetic Git fixture uses an isolated HOME, disabled system/global configuration,
empty templates/hooks and explicit synthetic authors. Runtime SQLite bindings
must match the build platform and architecture; build on the target platform.

Only the deterministic model's adversarial controls, fixture routes, audit hook,
delivery-availability wrapper, external HTTP forwarding and process-kill controls
are added. Normal open/read/question/decision/proposal behavior uses the unchanged
example responder and inspector. The actual packaged tools, channel, schedule,
Cyrus connector and worker artifacts/helper stay mounted.

```sh
COMMISSIONING_PROOF_ALLOW_RUNTIME=1 node tests/native-proof.mjs /absolute/consumer-stage
COMMISSIONING_PROOF_ALLOW_RUNTIME=1 node tests/cyrus-runtime-proof.mjs /absolute/consumer-stage
```

Run only in an isolated disposable environment with free loopback port 43229 and
Node 24. Review the candidate before running its isolated runtime probes.
The public harness has no private host/SSH/global Cyrus dependency. Both commands
use synthetic credentials and external services, never a paid/live model or real
Linear message. Public registry access is needed to install declared dependencies.

The native harness observes actual default handler cron without MCP polling,
queued native turns and one history import, worker privacy, valid session denial
with a positive counterpart, committed-artifact revision/acceptance, unknown
external handoff reconciliation and an actual SIGKILL after native send/before
acknowledgement. It honors the real receipt lease, so execution takes several
minutes. Empty cron observation is one additional minute.

The released Cyrus probe loads the actual generated MCP map, exact tool policy,
worker instructions and helper through its pinned released runner. Only its
model provider and external Linear HTTP behavior are simulated. The probe does
not establish real Linear webhook intake, service identity/secret-provider
configuration, a production Cyrus start, or judgment by a live model.

Receipts identify the candidate tarball and completed scenarios. Keep failed
receipts and logs alongside successful runs. Native raw stream output contains
synthetic continuation capabilities; sanitize them before sharing an artifact,
then rerun `tests/verify-native-stream.mjs` on the sanitized stream.

Known generic notification-starvation and overdue-lifecycle defects remain
outside this bounded public-consumer qualification. A failure is reported; these
controls do not silently fix or certify the broader backlog.
