# Changelog

## 0.1.0

The first release. A working-memory provider for eve 0.91: an agent's open loops, standing orders and notes in one SQLite file (`node:sqlite`, schema `user_version` 1), recalled at every turn's start as two messages, `working:here` and `working:standing`, which are never empty and never throw. Stores written by pre-release commits of this package aren't supported.

- **Tools** `open`, `update`, `close`, `order`, `lift`, `note` and `list`, with identity and conversation taken from the session and the host's `conversation()` resolver, never from arguments. `update` changes a loop's fields; it doesn't add notes (the `note` tool does). `workingToolSpecs` exports the descriptions and schemas for an eval harness.
- **Wakes.** `@eve-plus/working/store` gives the host's wake engine `openWorkingStore`, `claimDue`, `settleWake`, `failWake` and `eventOccurred`, with `wakeSeq` on each claim for the send's idempotency key.
- **Import.** `importLoop` brings a loop in from an earlier store once per external id; `onFirstOpen` runs the host's import on every open, by the provider and by the wake engine, so it must be idempotent, as `importLoop` is.
- **Attribution and detection.** Every change is an event with its origin; `history` and `revertBatch` by session, turn, call or principal. An order lifted or replaced by anyone but its setter logs `[working] order-change`, and a loop changed from another kind of turn logs `[working] loop-change`, each with both origins and a running count.
- **Bounds.** Caps on open loops, active orders and live notes; retention of closed entries; history per entry; writes per session; links limited to http(s) and the configured `linkSchemes`; order subjects normalised to plain ASCII.
- **Exports.** `.` is the provider and its types, for an agent's memory file; `./store` is the store and wake API, for the host's wake engine and import, kept apart so an agent's memory file doesn't pull in the engine's surface; `./stats` and the `eve-working-stats` bin read a store.

### `eve-working-stats` fields

The header is `eve-working-stats <version> dir=<dir> stores=<0|1>`, with `error=` when the directory itself can't be read. It says `stores` and `store`, not `eve-memory-stats`' `scopes` and `scope`, because a working directory holds one store, not one per scope. The store line:

| Field | Meaning |
| -- | -- |
| `store` | The store's file name. |
| `user_version` | The schema version. |
| `quick_check` | SQLite's integrity check; `"ok"` when sound. |
| `open`, `delivering`, `done`, `dropped` | Loops by status. |
| `orders_active`, `orders_lifted`, `orders_replaced` | Orders by status. |
| `notes` | Notes not yet expired. |
| `stale_loops`, `stale_orders` | Open loops and active orders past their review date (an order also when its `until` has passed). |
| `pending_wakes`, `undeliverable_wakes` | Open loops with a wake still to send, and with one given up or never deliverable. |
| `files` | Each store file as `name:uid:gid:mode`. |
| `findings` | `none`, or what's wrong: unreadable, a failed integrity check, or file ownership and modes. |

A store that can't be read keeps `store=`, `files=` and `findings=` and drops the counts.
