# Changelog

## 0.1.0

The first release. A working-memory provider for eve 0.91: an agent's open loops, standing orders and notes in one SQLite file (`node:sqlite`, schema `user_version` 1), recalled at every turn's start as two messages, `working:here` and `working:standing`, which are never empty and never throw.

- **Tools** `open`, `update`, `close`, `order`, `lift`, `note` and `list`, with identity and conversation taken from the session and the host's `conversation()` resolver, never from arguments. `workingToolSpecs` exports their descriptions and schemas.
- **Wakes.** A loop with a `revisit` is a follow-up. `@eve-plus/working/store` exports `openWorkingStore` and `WorkingStore` with `claimDue`, `settleWake`, `releaseWake` and `eventOccurred` for the host's wake engine, `followupNoteOf` and `LOOP_WAKE_OPENING` for the wake text, and `parseWhen` and `parseOn` for the `revisit` grammar.
- **Follow-ups import.** `migrateFollowups`, or the `followups` option, imports a `followups.sqlite` once, idempotently.
- **Attribution.** Every change is an event with its origin; `history` and `revertBatch` by session, turn, call or principal. An operator's order lifted or replaced from another origin kind logs `[working] order-change` with a running count.
- **`eve-working-stats <dir>`** prints a header and one `key=value` line per store, in `eve-memory-stats`' shape.
