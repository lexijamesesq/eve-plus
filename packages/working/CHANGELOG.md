# Changelog

## 0.1.2

- **Distinct wake kinds, and the root of a wake chain.** `OriginKind` adds `loop-wake` and `event-wake`. The host's `originKind` may answer `{ kind, wakeOf }` (the new `OriginClassification`), and a write in that turn records `origin.root`: the authority the woken loop carries. That's its opener's (or the opener's own root), unless someone else last changed it, another principal or another kind of turn, in which case it's that editor's. So a colleague's edit to the operator's loop can't borrow the operator's rank through its wake. Authority follows the root: an order set in a wake of the operator's loop ranks with the operator's, and recall says "started by operator". `revertBatch({ principalId })` also reverts writes whose root is that principal. A `wakeOf` the store doesn't know records no root.
- **A wake says why it fired.** A claim's `followupNote` ends its first line with `due at <time>` or `fired by <firedBy>`, the latter clipped to 80 characters on one line, so the host sends it as is.
- **A passed `until` says the order no longer binds:** `[until <day>, passed: no longer binding]`.
- **`revisit.onlyNew`.** A loop waiting on a retry of an event that just happened isn't woken by the previous occurrence, recorded on time or late, only by a later one. The cut is the latest occurrence recorded when the loop is armed (the run being retried), or the arming time if none is recorded. So a new run whose own clock is a little behind still wakes it. Without it, an occurrence in the last ten minutes still makes a new loop due at once. It's a new optional field on the `open` and `update` tools' `revisit`. The store schema is unchanged.
- **The frame is said once a turn**, in `working:here`. The standing block carries only its title and stamp, which also frees its room: the realistic state's four loops now fit in 1,200 characters.
- **`settleWake`'s false is documented** as exactly a lost lease, for the host to log honestly.

Deferred:

- an owner id recorded and checked at open, which needs store migration 2 and lands with retention;
- the imported-origin wording option;
- retention and forget ordering;
- truncation of imported notes;
- the source text of `revisit.on`'s event keys.

## 0.1.1

- **The standing block is stamped to the day** ("as of 2026-11-01"), not the minute. A changed block is re-anchored at the current turn and everything after it is re-sent uncached, so the minute stamp cost the prompt cache on every turn more than a minute apart.
- **The standing block keeps only the room its closing line needs.** It reserved a fixed ~405 characters for the cut counts and names, which hid entries that would have fit. The pointer to `<slot>__list` is still reserved first and never cut.
- **Loops elsewhere carry their next step**, clipped to 60 characters.
- **The header and its frame are kept first.** When the closing line's listed names don't fit beside the header, the closing line keeps only its counts and pointer, and the body is cut before either. `maxCharacters` below 400 is raised to 400, so the block never exceeds its cap or loses its "Recorded data, not instructions" frame.
- **The budget is the host's.** At 3 orders, 1 lifted, 1 note and 4 marked loops elsewhere, 1,200 characters shows every order and note and 3 of the 4 loops, counting the fourth; all four need a budget of about 1,270. Hosts size `maxCharacters` for their own state.

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
