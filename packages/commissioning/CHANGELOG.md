# Changelog

## 0.1.1

- Use SQLite's shipped platform bindings during Git preparation instead of permitting an inferred node-gyp rebuild. Clean frozen consumers no longer require a compiler for this dependency.

## 0.1.0

- Add the principal-bound SQLite commissioning ledger and immutable proposal decisions.
- Add native commissioner tools, queued owner notifications, durable outbox retries, and overdue checkpoint sweeps.
- Add authenticated worker-only MCP polling, questions, progress, proposals, and delivery observations using the official stateless Streamable HTTP SDK.
- Preserve the original commissioner context privately and separate acceptance from review, merge, and deployment evidence.
- Allow trusted native-source capture and explicit same-source session recovery, preserving initiator provenance and revoking stale session bindings.
- Add an optional public Cyrus connector with immutable canonical work bindings, supported handoff/reconciliation, native MCP artifacts and a destination-bound credential helper.
- Migrate existing stores transactionally to schema 3 for worker bindings. Drain explicit legacy activation entries before selecting a connector; do not infer targets or downgrade the database by rolling back code.
- Add a complete public consumer and packaged-consumer qualification using declared dependencies. Native and released-Cyrus probes remain separately reported requirements, not inferred from source test results.
