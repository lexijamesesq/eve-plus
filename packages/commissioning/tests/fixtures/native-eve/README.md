# Native runtime fixture

Run only on the approved isolated eve host after package review. This fixture uses public `eve/evals` deterministic `mockModel` and synthetic identities; it makes no live model request. It is excluded from published package files.

Set `FIXTURE_DATA_DIR` to an absolute durable scratch directory and `FIXTURE_AUDIT` to a JSONL audit path before build and runtime. Install the packed candidate in place of the development file dependency, then run `eve build` and `eve start --host 127.0.0.1 --port 43229`.

POST `/fixture/open` starts a real native owner turn and calls `commissioning__open`. The audit `opened.output` contains its commission ID. The worker connects to `/commissioning/mcp` with synthetic `Authorization: Bearer fixture-worker-only`, records questions and reports through the official client, and reads answers through `commission_read`.

POST `/fixture/unbound` with `{commissionId,questionId}` sends the same verified owner through an unrelated native session. Target a real unanswered question. Its attempted `commissioning__decide` must fail with the binding-specific denial and leave that question unanswered. Then POST the same IDs to `/fixture/bound` to send a native decision from the original owner session and require that same question to become answered; this tests trusted session binding in addition to ledger ownership. The worker MCP route does not advertise any owner operations.

Each notification audits the count of the original context sentinel; it must remain exactly one across retries and later notifications. Successful question decisions audit a real authored decide tool result. Use the native eve stream/session history to verify turn IDs and queue behavior independently of the audit file.

For the separate process-kill receipt control, set `FIXTURE_FAULT_BEFORE_ACK=1` and `FIXTURE_FAULT_MARKER` to an absolute scratch path. The fixture-only native SQLite wrapper kills the actual eve host with SIGKILL immediately before the delivered-receipt SQL runs, after the native send has returned. The packed extension and generated eve artifact stay unchanged. Restart with fault mode unset using the same durable directory and Workflow World, then retry/reconcile the same event. Verify the outbox recovers while the recent native delivery key prevents another owner turn. Run the normal proof with no fault environment first; label the injected control separately.

Artifact inspection is supplied by `agent/tools/inspect.ts`: it reads the current proposal from the ledger and independently inspects the full Git commit in `FIXTURE_GIT_DIR`. Prepare that repository with an initial `acceptance.txt` that differs from `ready`, then a second commit containing `ready`. Report the first immutable proposal and require revision, then report the second and require acceptance. Worker summary claims do not affect inspection. This is fixture evidence, not a new estate merge policy.

Two additional fixture-only commit-boundary controls are available through
`FIXTURE_FAULT_AFTER_COMMIT=question` or `decision`. They wrap the public SQLite
transaction function, wait for its real commit, and SIGKILL before returning
control to the transport or native tool. Use question IDs `crash-question` and
`decision-question`, respectively. Restart with fault variables unset and retry
the same canonical operation. The candidate package remains unmodified.

A `FINAL_JSON_ONLY` question returns final owner text shaped like an answer
without calling the decide tool. Its question must stay pending. The fixture's
explicit Eve channel uses synthetic Basic credentials only for reading the
public native session stream. The inspector audit records the commissioned
session ID so the proof can verify queued turns and one history import from
`/eve/v1/session/:sessionId/stream?follow=false` independently of model text.
