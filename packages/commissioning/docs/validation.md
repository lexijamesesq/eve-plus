# Public consumer validation

The package's public contract is a worker-neutral commissioning extension plus a usable, optional Cyrus connector. A configured consumer must not import private application code or reimplement connector handoff. Qualification uses the actual packaged connector; only external service responses may be simulated.

## Routine source checks

From the repository root, with Node 24 and the pinned pnpm:

```sh
pnpm --filter @eve-plus/commissioning run typecheck
pnpm --filter @eve-plus/commissioning test
pnpm --filter @eve-plus/commissioning run build
```

Existing Vitest suites cover SQLite/operation semantics, dispatch, public authored contributions and the official MCP SDK transport. Connector cases inspect actual serialized service requests and independent synthetic response state. They distinguish commit-before-response-loss from failure before applying, conflict, unavailable readback, changed binding and private-data leakage. A green source suite does not establish native discovery, cron, Cyrus configuration compatibility or live operation.

## Clean packaged consumer

```sh
pnpm --filter @eve-plus/commissioning run test:consumer
```

The public staging script builds/packs the local candidate, records its identity and copies the canonical `examples/cyrus` consumer outside the monorepo. It installs the tarball and declared public dependencies without authoring symlinks or private overrides. It imports every documented export, typechecks the actual mount and host APIs, builds the consuming eve agent, checks discovery/native external metadata and exercises installed SQLite persistence.

The clean consumer typechecks and builds both Cyrus-selected and neutral-off configurations. Those checks do not execute agent turns or external handoff. The runtime probes below must additionally exercise the actual selected connector against synthetic external responses and verify neutral mode without Cyrus setup or service requests. Fixture controls may be added to that same staged consumer after the unchanged example is checked. They must not supply behavior missing from the teaching example or replace contributed package tools/channel/schedule.

## Native eve and Cyrus probes

The staging report identifies the consumer directory. Run the prepared probes against that stage on a suitable isolated eve host:

```sh
node packages/commissioning/tests/prepare-native.mjs /absolute/consumer-stage --install-cyrus
COMMISSIONING_PROOF_ALLOW_RUNTIME=1 node packages/commissioning/tests/native-proof.mjs /absolute/consumer-stage
COMMISSIONING_PROOF_ALLOW_RUNTIME=1 node packages/commissioning/tests/cyrus-runtime-proof.mjs /absolute/consumer-stage
```

Prepare on the runtime platform so SQLite and any packaged native dependencies match it. The explicit runtime opt-in starts isolated local processes; preparation alone is not execution evidence. Use the harness's documented loopback controls, never a production endpoint.

Native eve qualification uses public `eve/evals` deterministic models and loopback routes. It must execute native open/read/decide, real worker MCP read/consult/report, private projection, explicit decisions, queue/history and binding controls. Actual handler cron is observed without MCP polling triggering reconciliation; manifest discovery alone is insufficient. Empty sweeps must create no model turn. Selected negative controls have valid positive counterparts and detect a real omitted/bypassed behavior, not a broken import.

Cyrus conformance uses declared public `cyrus-claude-runner@0.2.73` and `cyrus-core@0.2.73`, with the resolved Claude Agent SDK version recorded. It loads the packaged connector's generated MCP map, exact tool policy, helper and instructions, uses a loopback synthetic model provider and calls the actual MCP endpoint. It must never resolve a private global Cyrus installation or replace the runner with a fake implementation. Registry metadata or the historical target version does not establish successful execution.

These probes are separate from the ordinary source suite. Runtime prerequisites and actual results must be reported; an unavailable prerequisite is not a pass. No paid model, real work-service message or production credential is needed for synthetic qualification.

## Evidence and limits

Each report identifies the exact tarball SHA-256, dependency/runtime versions, commands, successful and failed assertions, and simulated boundaries. Sanitize continuation capabilities and credentials from public streams; retain enough queue/history and request evidence for independent review. Historical receipts do not qualify a changed candidate.

The corrected candidate has passed the isolated native eve and released-Cyrus probes with deterministic providers and synthetic external services, including restart and canonical owner-session recovery controls. These results do not establish live Linear webhook intake, real credential custody, production deployment or model judgment. Live service qualification and release checks remain outstanding.

CI's Git-consumer export check and a configured local-tarball consumer are distinct checks. Preserve both; public contributor commands must work before any publication is considered. Publication and deployment require their own explicit review decisions.
