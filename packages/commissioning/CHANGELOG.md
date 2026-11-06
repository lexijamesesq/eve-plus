# Changelog

## 0.7.1

Documentation only. The 0.7.0 entry's note on rolling back to 0.6.2 said a 0.6.2 reader ignores the new events; it
can lose a queued closeout instead, and the note below now says how, and what to check. No code change.

## 0.7.0

The conversation between the commissioner and the worker, fixed in four places. One interface change is breaking:
a custom worker connector must now implement `complete` (see the last item).

- **The commissioner sees the worker's latest checkpoint.** `commissioning__read` now shows the most recent
  checkpoint's text and time. Checkpoints were stored but never rendered, so a commissioner reading a commission
  concluded the worker had reported none.
- **A note the commissioner can send at any time: `commissioning__note`.** Until now `decide` was the only way to
  reach the worker, and each question or proposal takes exactly one final decision, so a status message
  ("hold on merging") used up the verdict. A note takes `{ commissionId, text }`, appears among the events the worker
  reads with `commission_read`, and decides nothing: it doesn't answer a question or settle a proposal. It doesn't
  restart the worker's quiet-time clock, since that tracks the worker's activity. A note on an accepted commission is
  refused: the worker's session has ended, so a note would go unread. The note's identity comes from the
  tool call, so a retried call records it once. The tool description says plainly that this is the only way to tell
  the worker something and that a Linear comment doesn't reach it. No change to the worker's three tools.
- **The Cyrus contract says when to propose.** The contract comment now tells the worker to submit its proposal once
  the repository's code review has cleared the head commit, not when the pull request opens, so a proposal isn't
  spent on a head that review is about to change. A handoff that posted its contract comment under 0.6.2 and had
  not yet delegated when the agent upgrades sees a different contract text and stays pending as a conflict.
  Opening the commission again can't recover it: the stale contract comment is still on the issue, so `open`
  refuses that issue. Commission the work afresh on a new issue and treat the old commission as superseded.
- **Accepting a proposal closes out the work.** An accepted proposal queues a closeout in the same transaction as
  the decision, delivered like the handoff: leased, at least once, retried by the dispatcher and the reconcile
  schedule. The Cyrus connector's new `complete` moves the Linear issue to its team's completed workflow state with
  the access token it already uses for the handoff, and does nothing when the issue is already completed. A
  connector must implement `complete`, which is a breaking change for custom connectors: add one that resolves when
  the work is closed out, or already was, and rejects when it can't act right now so the closeout is retried
  rather than lost.

No store schema change: a store written by 0.6.2 opens unchanged, and 0.6.2 opens one written by 0.7.0. A 0.6.2 worker
reads `note` and `complete` events as events of an unfamiliar kind. Rolling back to 0.6.2 can lose a closeout: its
dispatcher sends every outbox entry other than a handoff to the commissioner as a notice, so a closeout still queued
arrives as "Commission … has a new complete event", is marked delivered, and its issue is never completed; 0.6.2 also
never closes the issue of a proposal accepted after the rollback. The ledger can't tell a delivered closeout from a dropped
one, so check the issues: before rolling back, confirm each commission accepted under 0.7.0 has its issue completed, and while
0.6.2 runs, complete by hand the issue of every commission it accepts.

## 0.6.2

Supports eve 1.0.0-rc.6 beside 0.91: the peer range is `^0.91.0 || 1.0.0-rc.6`, exactly that release candidate and
no other prerelease or 1.x. Tested against both.

- **The extension is still built with eve 0.91.0.** A git install runs `prepare` with this package's own
  devDependency eve, and eve refuses an extension distribution built by a newer eve: built with 1.0.0-rc.6,
  `dist/extension/_manifest.json` records `builtWithEve: "1.0.0-rc.6"` and an agent on 0.91 fails its build with
  "was built with eve 1.0.0-rc.6". Built with 0.91.0, the one distribution builds on both. So the build eve stays
  0.91.0 until 0.91 is no longer supported.

No API or store schema change. A store written by 0.6.1 opens unchanged, and 0.6.1 can still read one written by
0.6.2.

## 0.6.1

No behaviour change. The README, usage guide and tests use neutral example names for the commissioning agent
and its MCP server.

## 0.6.0

Built and tested against eve 0.91.0; the peer range is `^0.91.0`.

- **The extension is built with eve 0.91.0.** eve 0.84.0 and later reject an extension distribution built by an
  earlier eve, and a consumer's install runs `prepare` with this package's own devDependency eve, so 0.5.3 always
  builds one 0.91 refuses. The built `dist/extension/_manifest.json` now records `formatVersion: 3` and
  `builtWithEve: "0.91.0"`.
- **0.91 or later only.** eve 0.83.2 can't load a distribution built by 0.91, so this release can't stay
  dual-range. An agent moves to 0.6.0 in the same change that moves it to eve 0.91.0, and an image built with
  0.5.3 keeps working on 0.83.2.
- **A redelivered notice reaches the conversation once.** Each notice is sent with an idempotency key that names
  its outbox entry, so a send repeated after a crash before its acknowledgement is taken once by eve, which
  remembers a session's recent keys.

No API or store schema change. A store written by 0.5.3 opens unchanged, and 0.5.3 can still read one written by
0.6.0.

## 0.5.3

A checkpoint reaches the commissioner while a proposal awaits its verdict. Until now every checkpoint was recorded
quietly, so a commissioner holding its verdict until the pull request merged had nothing to wake it: the worker's
checkpoint that the PR merged was recorded and never delivered. Checkpoints at any other time are still quiet, and
failures and proposals are delivered as before. No API or store schema change.

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
