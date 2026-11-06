# Changelog

## 0.6.4

Supports eve 1.0.0-rc.6 beside 0.91: the peer range is `^0.91.0 || 1.0.0-rc.6`, exactly that release candidate and no other prerelease or 1.x. Built and tested against 1.0.0-rc.6, and tested against 0.91.0. No API or store change: a store written by 0.6.3 opens unchanged, and 0.6.3 still reads one written by 0.6.4.

## 0.6.3

- **The tool descriptions and the turn-start block say what each tool does, once.** The handle, and how to cite or open a record with it, was explained in the turn-start block and in four tool descriptions; `remember` described the name-taken and ontology replies its own results already give. The turn-start block is now data: the facts with their handles, and a `recall` pointer when there are more. Each description is one line, with a pointer to `get` where a words-search tool and the handle tool overlap. The mechanics stay on the input fields (`id`, `attributes`, `relations`) and in the replies. No behaviour or store change.

## 0.6.2

- **Search finds names in any script.** `recall`, `relate` and the turn-start block used to read only unaccented `a`–`z` and digits from a query, so searching "Zoë", "José" or "李明" found nothing, even with the record stored. Words are now letters and digits in any script, NFKC-normalised as handles are, and accents are optional: "zoe" finds "Zoë Park" and "garcia" finds "José García". One- and two-letter words stay noise in every alphabetic script, accented or not ("à" and "où" fold to "a" and "ou"), but in Han, kana and Hangul a short word is kept, so a name such as "李明" isn't dropped. ASCII searches match as before. No store change: the index already held these words, so nothing is rebuilt.

## 0.6.1

- **`eve-memory-migrate`, a command that gives a store's older records their handles.** A dry run plans each store under a directory on a copy and prints every clash (records whose names make one handle) with a proposal, `duplicate`, `namesake` or `unclear`, and lettered options, each tried on the copy. The printed report has no detail values; `--report -` prints the full one on stdout and the shareable one on stderr. Apply carries out your decisions with the agents stopped: carry-overs, merges, new names, then handles, each clash reverted alone if it fails, and a clash with no decision or that changed since the dry run skipped. Every write carries the run's origin, so `revertBatch({ run })` undoes it. References the upgrade or the migration would break are reported, and a handle that would capture one is taken back. See the README's "Migrating a store to handles".
- **`eve-memory-stats` counts `records=`, `edges=` and `triples=`** alongside `handles=`, so readings before and after a migration reconcile with its result line.
- **`MemoryGraph.stored(id)` and `storedIds()`** read a record exactly as stored under its internal id, without resolving or following merges, for operator tools.
- **`merge` retracts a merged record written to again under its own id**, such as by a version before 0.6 after a rollback. Before, resolving it led to its survivor, so it couldn't be merged again.

## 0.6.0

Every record now has a **handle** made from its name, which the agent writes, sees and resolves: "Alice" is `knowledge:alice`, "José García" is `knowledge:josé-garcía`. A record's id never changes; the handle is how it's addressed. Breaking: `remember` creates only without `id`, and `id` names a record to update.

- **Handles.** Made from the record's name: Unicode letters kept, lowercase, one `-` between words, at most 118 characters, so `knowledge:<handle>` fits a link. A name with no letters or digits is refused. `handleOf(name)` is exported. Handles live in their own table, written with the record and attributed like every other write, so `history` shows them and `revertBatch` undoes them. They are not details: they stay out of the attributes, the search index, rule checks and the fact count. `eve-memory-stats` reports them on their own, as `handles=<n>`.
- **Shown everywhere.** The turn-start block, `recall`, `relate` and each of its connections, `check_memory`, and `remember`'s reply give each record's `knowledge:<handle>`. The tool descriptions tell the agent that handles are how records are addressed.
- **`get`, a new tool.** It opens one record by its handle, with its details and connections. A slightly wrong handle gets the nearest handles as suggestions. `recall` stays the search by words; its description now sends a known handle to `get`.
- **A create on a taken name fails and names the holder.** A save without `id` whose handle is taken returns the holder's label, type and handle, so the agent updates that record on purpose or qualifies its name ("Sam (Acme)" is `knowledge:sam-acme`). The result carries the same as `holder`. The same save arriving twice succeeds with the record that holds it. Two same-name saves at once give one record: the handle has a unique index, so the second fails cleanly or, if identical, returns the first. This replaces the label match that let a second save with different content mint a second record.
- **Renames keep references working.** Renaming a record gives it the handle of its new name, and its earlier handles still lead to it. A rename onto a handle another record holds fails the same way.
- **Forgetting reserves the name.** A forgotten record's handle resolves to "forgotten", never to a newer record. A save on it is told so. Saving the record by its handle brings it back. `MemoryGraph.reclaimHandle(handle)` frees a forgotten or earlier handle for the next record named for it.
- **One resolver.** `MemoryGraph.resolve(ref)` takes `knowledge:<x>` or `<x>`, and tries the current handle, then an earlier handle, then the internal id (as written, or in another case, as before), then the handle `<x>` makes as a name. It follows merges, and answers `found`, `forgotten`, or `missing` with suggestions. `remember`'s `id`, its connections' `to`, `forget`, `describe` and `history` all go through it, and the internal id is what's stored. A handle is unique within its scope's graph and resolves only there.
- **Breaking: `id` names a record to update.** A `remember` whose `id` resolves to nothing fails with suggestions instead of creating a record under that id. A misspelled handle would otherwise make a second record. New records always get a minted id, and a new record needs a `label`. A connection to something that resolves to nothing, or to a forgotten record, fails the same way instead of storing an edge to nothing. A new handle equal to another record's id is refused.
- **Merges.** `MemoryGraph.merge(duplicate, into)` records that two records are one thing and retracts the duplicate in the same write, as a merged page becomes a redirect. The duplicate's handles, its id and connections to it lead to `into`, and nothing is rewritten. Carry details worth keeping over to `into` first; reverting the merge brings the duplicate back.
- **`revertBatch` reports conflicts.** A revert that would leave a record answering to a handle another record now holds isn't applied. It returns `conflicts: [{ id, handle, heldBy }]`, and nothing is removed.
- **The turn-start block drops whole lines.** Past `maxCharacters`, records that don't fit are left out with a note to use `recall`, instead of the block being cut mid-line. Before, a cut could leave half a handle.

### Upgrading from 0.5

The store migrates on open: it gains the handles table, at `user_version` 5. **No handle is given to an existing record on open**, nor when one is renamed. Two old records can share a name, and settling that is the operator's call. Until a record has a handle, every surface shows its id in the handle's place (`knowledge:jordan_lee_x7k2`), and that resolves.

Give existing records their handles with `MemoryGraph.mintHandle(id)`. It makes the handle from the record's current name (a forgotten record's from its last), does nothing if the record already has it, and fails, naming the holder, when another record has it. Do this before agents write to the upgraded store. Meanwhile, a new save whose name would make an old record's handle fails and names that record, so a new record can't take an old one's name.

`remember({ id })` no longer creates. Code that created records under chosen ids saves them without `id` and addresses them by the returned `handle`.

## 0.5.2

- **`onOpen(graph, scope)`.** Runs once each time a scope's graph is opened in the process, with the scope eve resolved for it, so a host can join this memory to another: keep the graph by the scope's value and answer a `knowledge:<id>` reference with `graph.describe(id)`. The hook may be async. A hook that throws or rejects is logged and never fails the open, which does not wait for it. Nothing changes without it.
- **Attributes may reference other memories.** The `remember` tool's `attributes` description now says a value may reference another memory by id (`knowledge:<id>` or `working:<id>`). Such values were always kept and shown as written, at turn start and in `recall`; this documents and tests it.

## 0.5.1

No behaviour change. The tests use neutral example names.

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
