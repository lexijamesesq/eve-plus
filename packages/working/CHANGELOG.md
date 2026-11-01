# Changelog

## 0.1.0

The first release. A working-memory provider for eve 0.91: an agent's open loops, standing orders and notes in one SQLite file (`node:sqlite`, schema `user_version` 1), recalled at every turn's start as two messages, `working:here` and `working:standing`, which are never empty and never throw.

- **Tools** `open`, `update`, `close`, `order`, `lift`, `note` and `list`, with identity and conversation taken from the session and the host's `conversation()` resolver, never from arguments. `workingToolSpecs` exports their descriptions and schemas.
- **Wakes.** A loop with a `revisit` is a follow-up. `@eve-plus/working/store` exports `openWorkingStore` and `WorkingStore` with `claimDue` (at most `claimLimit` a tick, oldest due first), `settleWake`, `failWake` (retried after its lease, given up as undeliverable when final or after `maxWakeAttempts`) and `eventOccurred` (recent occurrences remembered, so a loop opened just after its event is due at once) for the host's wake engine, `followupNoteOf` and `LOOP_WAKE_OPENING` for the wake text, and `parseWhen` and `parseOn` for the `revisit` grammar (`on` names one of the host's `events`).
- **Bounds.** Caps on open loops, active orders and live notes (`limits`, defaults 200, 50, 100), bounded history per entry (`eventsPerEntry`, default 50), and links limited to http(s) URLs and the reserved `knowledge:`, `working:`, `vault:`, `linear:`, `slack:` and `github:` references.
- **Stored data.** A loop keeps only the sender fields a wake needs; the store's directory is `0700` and its file `0600`.
- **Follow-ups import.** `migrateFollowups`, or the `followups` option, imports a `followups.sqlite` once, idempotently. A bad row is skipped and named; an unreadable file or failed import never stops the store opening.
- **Failures.** A tool whose store fails answers with a refusal, not a raw error, and recall caps each line and counts what doesn't fit rather than stopping.
- **Attribution.** Every change is an event with its origin; `history` and `revertBatch` by session, turn, call or principal. An order lifted or replaced by anyone other than its setter logs `[working] order-change` with both origins and a running count.
- **`eve-working-stats <dir>`** prints a header and one `key=value` line per store, in `eve-memory-stats`' shape.
