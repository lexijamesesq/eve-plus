# Changelog

## 0.4.0

- Add explicit EdDSA (Ed25519) signed worker authentication using JOSE while preserving ES256 as the default and its native Eve verification path. Both algorithms retain strict issuer, subject, audience and bounded lifetime checks.

- Publish a portable worker-side release archive with the existing Cyrus configuration/header helper and signed credential factory, bundled with their licenses and requiring only Node 24.
- Keep worker code independent of Eve and SQLite while preserving the existing public module exports. Git preparation invokes the native build commands directly.

## 0.3.0

- Add optional `./auth` signed-worker credential and authenticator factories using native Eve verification and standard JOSE signing, with configurable bounded lifetime, clock tolerance and public-key rotation trust.
- Keep existing authentication callbacks unchanged; document generic custody composition and demonstrate signed mode in the public consumer.

## 0.2.0

- Keep default canonical notifications bound to the checked native session handle, and leave delivery pending if that session becomes inactive before accepting the send.
- Add optional synchronous `authorizeOwnerSession` for host-authorized owner sessions using captured trusted source context. Verified identity, stored ownership and worker exclusion remain mandatory; absent policy preserves strict session binding and explicit recovery.
- Document application-owned native delivery and its at-least-once notification semantics.
- Correct the standalone example to install the actual packed artifact filename.

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
