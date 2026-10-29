# Changelog

## 0.5.2

The worker endpoint's `commission_report` publishes its arguments. It was registered with a discriminated union,
which the MCP SDK publishes as an empty object, so a worker was shown no arguments and every report failed. It now
publishes one flat object: `commissionId`, `eventId`, `kind` (checkpoint, failure or proposal), and `data` with
`summary` and an optional `artifact`. The per-kind rules still apply in the handler: a proposal needs an artifact,
and a checkpoint or failure can't carry one. No other API or store change.

## 0.5.1

The Cyrus contract comment no longer shows HTML-comment markers as text. Linear renders an HTML comment visibly, so
the contract now opens with its heading, `## Commissioning contract`, followed by `Commission ID: <id>`; the rest of
it is unchanged. That heading is also how a contract is recognized on an issue, so an issue holding a contract
written by 0.5.0 or 0.5.1 is still refused as already commissioned. A Cyrus that finds its contract by the heading and
the `Commission ID:` line reads either version. No API or store change.

## 0.5.0

A breaking rework to what commissioning needs: the commissioner and the worker can talk, and nothing more. Stores
from earlier versions aren't migrated; start 0.5.0 on an empty `dataDir`. The ledger is schema 4, and 0.5.0 refuses
any other with a message naming it.

**Rolling back:** 0.4.0 can't open a 0.5.0 ledger. Roll back by restoring the previous image with its previous
`dataDir`, and never point 0.4.0 at a ledger 0.5.0 wrote.

### Changed

- **Worker auth is your check.** `authenticateWorker(request)` returns `true` for the worker. Pair it with one
  long-lived token both sides hold. `workerPrincipalId` and the `./auth` signed-credential helpers are gone, and so
  is the `jose` dependency.
- **Notices go to the conversation the work was opened in.** `deliver(conversation)` names a channel, target and
  auth, and the package sends each notice with eve's `to(channel, target)` as a queued turn. It checks that the
  delivery's auth maps back to the commission's owner first. The separate continuation session and its recovery
  recipe are gone.
- **One authorization rule.** `commissioner(auth)` returns the commissioner and the conversation. An owner can act
  only from the conversation a commission was opened in. It replaces `resolveSessionPrincipal`,
  `resolveDeliveryAuth`, `captureSource` and `authorizeOwnerSession`.
- **A worker is required.** Every commission names a work reference and is handed off through the configured
  connector.
- **The owner's tools answer in plain language.** `commissioning__read` takes only `commissionId`. A worker
  that's briefly unreachable while a commission opens says to try again, and logs one fixed-field warning; any
  other failure refuses the work reference.
- **One store schema, with no migrations.**

### Removed

- Delivery observations (`reviewed`, `merged`, `deployed`) and owner-only `privateGuidance`.
- The portable worker archive, the Cyrus headers helper and `createCyrusWorkerArtifacts`. A Cyrus host now reads
  the token from its environment in a static MCP configuration; see `docs/usage.md`.
- The `./store`, `./transport`, `./config` and `./auth` exports. A consumer configures the mount (`.`) and the
  connector (`./cyrus`), which also exports the configuration types.
- The native and Cyrus runtime proof harnesses and the shipped example.

The peer range is `^0.83.2`, the version it's built and tested against.

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
