# Changelog

## 0.5.0

Built and tested against eve 0.91.0; the peer range is now `^0.91.0`. Earlier eve versions are no longer supported:
an agent takes 0.5.0 in the same change that takes it to eve 0.91.0. No API or stored-data change, so a store
written by 0.5.0 opens in 0.4.1.

- **No compaction recall.** eve 0.84.0 removed the `compaction.completed` recall hook, and `eve build` rejects a
  memory provider that still declares it, so 0.4.1 fails an agent's build on eve 0.91. Recall now runs only at
  `turn.started`. From 0.84 eve keeps recalled memory outside history, so compaction no longer drops it and there is
  nothing to recall again.
- **One id for the turn-start message.** From 0.84 a recalled message stays for the rest of the session and is
  replaced only by a later one under the same id. The "memory is unavailable" note had its own id, so it would have
  stayed after the outage ended, beside the earlier recall it says can't be seen. It now takes the recall's id, so
  each replaces the other.
- **The outage note ends with the outage.** A recall with nothing to show returns `null`, which keeps the session's
  last message, so after an outage a healthy turn with nothing to recall would have left the note in place. The
  provider now remembers, per session and scope in the process, what it last showed. The first healthy turn after an
  outage note, or the first in a session this process hasn't recalled for yet (after a restart, or a new session),
  replaces it with a one-line note that memory is available. After that, a turn with nothing to recall adds nothing,
  as before.
- **Attribution keeps eve's own principal key.** The speaker behind every write's `who` and `scopeOwner` is still
  computed by eve's `byPrincipal`, now given the tool call's channel, which 0.91 requires. `byPrincipal` reads only
  the session's auth, so the key matches the scope eve built, byte for byte.
- The approval-resume guard stays. It was needed while recall landed after the history's tail; under 0.91 skipping a
  recall keeps the previous one, so it costs nothing.
- The registration example no longer passes `visibility`, which eve 0.84.0 removed. The README installs from a
  release tag, as the other packages do.

## 0.4.1

Installs alongside eve 0.83. The peer range is now `^0.80.1 || ^0.81.0 || ^0.83.2`, and the package is built and
tested against eve 0.83.2. Every eve API it uses is unchanged in 0.83.2, so there is no change to its behaviour, its
API or its stored data.

## 0.4.0

Adds a way to tell, from the store itself, whether an agent's memory survived something done to it, such as a
deploy, an upgrade or a host move. No API change: stores migrate on their next open.

### Added: a write high-water mark and `eve-memory-stats`

- **A persisted write high-water mark.** Each store keeps `seq_hwm` in its `meta` table: the largest write sequence
  number it has ever assigned. It moves in the same transaction as every write, a `forget`'s tombstones included,
  and never goes down, even when `revertBatch` deletes the latest rows. A reading lower than an earlier one means
  the store was lost or replaced, which no row count can tell you, since counts fall legitimately.
- **`eve-memory-stats <dir>`, a read-only command.** For `<dir>` and each direct subdirectory holding a `graph.db`,
  it prints one line of facts. A symlinked scope directory counts, and one it can't look into is reported as
  unreadable rather than skipped:
  - `seq_hwm` and `max_seq`;
  - SQLite's `quick_check`;
  - `user_version`;
  - current facts and tombstones;
  - whether the search index holds exactly the current values (`search_index=<indexed>/<current>` with the
    missing and extra counts);
  - the owner and mode of `graph.db`, `-wal` and `-shm`.

  It ends with `findings=`, the problems visible in that one snapshot: an unreadable store, a failed check, an
  index out of step, rows past the mark, or a file whose owner differs from `graph.db`'s or the running user's.
  Comparing snapshots (a lower mark, a vanished scope) is left to whoever reads two of them.
- **`openReadOnly`, `scopeStats`, `scopesIn`, `findings` and `formatStats`** from `@eve-plus/memory/stats`, for
  reading the same facts from code.

### Read-only, precisely

`eve-memory-stats` opens each store with `readonly: true`, never through `MemoryGraph.create` (which migrates and
checkpoints). It never writes `graph.db` or the contents of its WAL. SQLite may create `graph.db-shm`, and an empty
`graph.db-wal` when a cleanly closed store has none, owned by whoever runs the command, so run it as the agent's own
user: as root it would leave root-owned files that lock the agent out. The directory has to be writable for that: a store in WAL mode
can't be opened on a read-only mount. It exits 0 whenever it ran, including when a store or the directory is unreadable,
which it reports. It exits 2 only on bad usage.

### Changed: sequence numbers are never reused

- **A write's sequence number is past both the mark and the highest row,** so 0.4.0 never reuses a number freed
  by `revertBatch`. Write order is unchanged otherwise. An older adapter doesn't know the mark and can reuse one
  (see Upgrading).

### Fixed: eve 0.81 is a supported peer

The `eve` peer range was `^0.80.1`, which under 0.x semver excludes eve 0.81. It's now `^0.80.1 || ^0.81.0`, and the
development pin is eve 0.81.0, which the test suite runs against. Nothing in the memory provider changed for 0.81.

### Upgrading to 0.4.0

The first open by 0.4.0 migrates a store to `user_version` 4 and seeds the mark from its highest `seq`, or 0 for an
empty store. Stores 0.4.0 hasn't opened yet report `seq_hwm=none`.

0.3.0 still opens a 0.4.0 store, but its writes don't move the mark, and it numbers a write one past the highest
row on disk. When that's past the mark, `eve-memory-stats` reports rows past it, until the next 0.4.0 write moves
the mark beyond them. When it isn't (0.4.0's `revertBatch` removed the latest rows, so 0.3.0 reuses their numbers),
nothing is reported: the mark can show that an older adapter wrote, not prove that one didn't.

## 0.3.0

A breaking change for 0.2.x consumers. 0.2.x's precedence was a misstep, and it's removed. It ranked a write by the
model's own `source` label, then refused writes it ranked below the user's. That refused real updates: a user who
relayed a fact ("the wiki now says the code word is green falcon") had it labelled content and kept from replacing
the old value. 0.3.0 goes back to 0.1.0's model, where every write lands, and keeps what 0.1.0 had: the append-only
log, `history`, `revertBatch`, per-principal scopes, the lint gate and the name caps. It adds attribution in place
of ranking.

### Removed

- **The `source` and `from` fields** on `remember`, `forget` and `extend_schema`. The model no longer says where a
  write came from. Extra fields are ignored, so an agent prompted to pass them keeps working.
- **Precedence.** A write from content no longer keeps a value back, refuses a second record under a user record's
  name, refuses a raw shape, or returns `kept` / "Not changed" results. `RememberResult`, `ForgetResult` and
  `ExtendResult` lose `kept`.
- **The `agentState` option.** It existed only to exempt records from precedence. Remove it from your
  `shaclMemory({ … })` call; TypeScript reports it as an unknown option.
- **The `⟨unconfirmed⟩` marks and the note asking the model to confirm** values with the user. `Fact`, `RelateResult`
  and `Description` lose `filed` and `approved`.

### Added

- **Attribution on every write,** from eve's session context: `who` (`owner`, `other`, `scheduled`, `delegated`), the
  `principal`, `scopeOwner`, `ownedScope` (whether the scope is one principal's), and the session, turn and call.
  `revertBatch` selects on any of them.
- **`recorded`, `recordedName` and `recordedType` on reads:** each detail's, and the record's name's and type's,
  `{ who, on }`. Recall renders a value as "recorded during the memory owner's own conversation on 2026-10-19", "by a
  scheduled run", "by a delegated task" or "during a conversation with someone other than the memory owner".
- **One rule:** a record type created or extended in the owner's own conversation, or a record typed there, changes
  type or definition only there. A refusal returns stage `owner-type` with a reason. A scope with no owner (a list
  or a shared key) has no such rule.
- **Detection:** a scheduled, delegated or other-principal write over an owner-conversation value logs one
  `[mem] owner-overwrite #N` warning, where N is the running count for that store since the process started.
- **`maxWritesPerSession`:** an optional cap on write calls per session. Past it, a write throws.
- **`MemoryGraph` is exported** from the package, so `history` and `revertBatch` are reachable without a deep
  import.

### Upgrading

No migration step: stores open as they are, and the schema log is unchanged.

- **From 0.2.x:** values written as `"user"` in the owner's live turn read as the owner's, and scheduled or
  delegated writes read as such. Other 0.2.x content values read as `legacy` (unmarked). Types and record types any
  0.2.x write set count as the owner's, except those 0.2.x recorded as scheduled or delegated.
- **From 0.1.0:** values read as `legacy` and are open to every writer. Types and record types count as the owner's,
  since they came from the owner's conversations, as do types a raw shape names. 0.1.0 recorded no way to tell the
  owner's writes from others', so this errs toward protecting the type; the owner can still change any of them.
- **Behaviour you'll see:** writes that 0.2.x kept back now land. If you relied on that to protect values, use
  attribution to find and revert what you don't want, and `maxWritesPerSession` to bound a run.

## 0.2.1

Fixes installing 0.2.0 from git. Installing it from git runs `npm install` in the package, which then runs its
`prepare` build, and npm refused the install: the development pin `ai@7.0.118` conflicts with eve 0.80.1's peer range
(`ai ^7.0.137`). The development pin is now
`ai@7.0.141`. There is no change to the package's behaviour or API; use 0.2.1 rather than 0.2.0.

## 0.2.0

A behaviour change for every consumer. Memory no longer pauses for approval; what the user stated outranks content
the agent is handed, and that rule is enforced by the store.

### Removed: approval gates

`remember`, `forget` and `extend_schema` no longer return `"user-approval"` from an `approval` policy. Previously:

- a content-sourced write that replaced a value paused;
- any `forget` of a whole record paused;
- a content-sourced `extend_schema` paused.

None of them pause now. That matters most for agents that run unattended (on a schedule, say), where a paused call
waited for a person who wasn't there. The held-approval store is removed, and its table is dropped when a store opens.

**If you relied on those pauses,** for example to show an approval card or to wait for a person before memory changed,
nothing will pause any more. The precedence rule below takes the pauses' place for content. To keep a human step for
your own reasons, wrap the memory tools in your agent with your own approval policy.

### New: precedence for what the user stated

Content can add facts beside the user's, and update or forget what content wrote. It can't do any of these:

- replace or retract a value whose current origin is the user's;
- create a second record under the name of one the user has, whether it's a new record or content renaming its own;
- change or add to a record type the user defined, or one a user raw shape names;
- add a raw shape at all.

**A refused write lands nothing and says what it kept.** For `remember`, the result says, for example, `kept phone:
the user said "555-0142"; this content claims "555-0999" … Tell the user about the conflict`. `extend_schema`
says the same for record types. A rewrite of the user's value with the same text under another datatype writes
nothing.

**Pre-upgrade values rank as the user's:** values written with `source: "user"`, values approved under 0.1.0, and
values with no provenance. Forgetting isn't protected: content may later re-add something the user forgot, recorded as
content.

### New: grounding "the user"

The model's `source: "user"` no longer makes a write the user's by itself. A write counts as the user's only when all
four of these hold:

1. the model says `source: "user"`;
2. the turn isn't scheduled work (eve's `session.schedule` is absent);
3. the turn isn't a delegated subagent session (`session.parent` is absent);
4. `byPrincipal` of the turn's authenticated principal equals the memory scope's value: the person talking is the
   person whose memory this is.

**Anything else is recorded as content, whatever the label says.** That covers:

- another principal writing into the scope;
- a missing session or source;
- every write to a scope that isn't one principal's, such as a list or a shared key.

**Requires eve `^0.80.1`,** for `session.schedule`.

**A residual remains:** content the user pastes into their own live turn, which the model then labels `"user"`, is
recorded as theirs. No channel signal separates the two. Attribution, `history` and `revertBatch` cover it.

### New: `agentState`

`shaclMemory({ dir, agentState: ["maintenance handoff"] })` names record ids that hold the agent's own working state
rather than beliefs about the world, for example a list of open items that any conversation may add to or clear. Writes
to those records are recorded with provenance `agent-state` and are never ranked by precedence. Records are matched by
id only, and the model can't declare one.

### Changed: schema changes are an attributed log

`extend_schema` now appends to an attributed log with one entry per change, so `revertBatch` undoes any schema change,
not only the latest, and `history`-style auditing covers schema too.

**Migration:** a 0.1.0 store seeds the log once from its existing record types and raw shapes, attributed as legacy,
which ranks as the user's. Nothing to do: it happens on first open.

**Downgrade:** a 0.1.0 build reading the store afterwards sees the record types as they were at upgrade, without later
schema changes.

### Breaking API changes

- `MemoryGraph.revertBatch` is now `async`. Its result adds `schema`, the number of schema entries removed.
- `MemoryGraph.holdApproval`, `MemoryGraph.takeApproval` and `MemoryGraph.previewSupersession` are removed.
- `RememberResult` and `ForgetResult` add `kept: Change[]`. `ExtendResult` adds `kept: true` on a refused change.
