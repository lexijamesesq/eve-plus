---
issue: none
status: implemented
last_updated: 2026-11-05
---

# Memory handles: a name an agent can write, see everywhere, and resolve to one record

`@eve-plus/memory` 0.6.0.

## Problem

An agent looks a thing up by what it knows: its name. Before 0.6.0, a record's id was agent-supplied or minted from
its name plus four random characters. The turn-start block and `relate`'s connections didn't show ids, and nothing
read by one. Two saves could mint two records for one thing, and the shared `slug()` turned "李明" into `x`. An agent
that wanted to cite a record in a link (`knowledge:<id>` on a task in `@eve-plus/working`) had nothing reliable to
write.

## Shape: a stable id plus a handle with history

The proven way to have both a stable identifier and a human-writable name is a hybrid: an internal id that never
changes, plus a unique slug used as the finder key, with history so old slugs keep resolving after a rename. Sources:
Rails `friendly_id` (a slugs table with a unique index, and finds by old slugs); Wikipedia (titles, and redirects on
page moves); Kubernetes (names backed by a UID). The constraint, not the writer, guarantees uniqueness, and create
and update are different verbs (Neo4j `CREATE` under a uniqueness constraint fails; `MERGE` matches). The most-copied
agent memory server (the MCP reference `memory` server) keys entities by a unique name, keeps type as a separate field,
and fails a relation to a name that doesn't exist.

```text
record  ──id (never changes)──▶  triples (attributed append log)
   ▲
   └── handles: live rows, one per handle string (unique index)
         current  = the live row its current label makes
         earlier  = its other live rows (renames)
         forgotten = live rows of a record with no current view
         merge    = "duplicate is into" (latest per duplicate)
```

## Authoring and tool API

### `handleOf(name): string`

Vendored and pinned, adapted from Django's `slugify(value, allow_unicode=True)` (`django/utils/text.py` at
`816ea69c`):

1. NFKC normalisation.
2. Lowercase.
3. Drop anything that isn't a letter, mark, digit or separator.
4. Collapse each run of separators (whitespace, `_`, `-`) to one `-`, and trim.

It differs from Django in two ways: combining marks are kept (Python's `\w` drops spacing marks, which breaks
Devanagari and other scripts), and `_` is a separator, so a handle has only one. Letters stay in their own script: "李明"
is `李明`, "Zoë" is `zoë`, and "Alice"/"alice" are both `alice` while "Alicé" is `alicé`.

The cap, `HANDLE_MAX`, is 118 UTF-16 code units (JavaScript string length). With the `knowledge:` prefix, a reference
is at most 128 units, under the 512-unit link limit in `@eve-plus/working`, and short enough for a turn-start line. A
longer handle is cut at the last `-` in range, or at a code point when there's no `-`, so a surrogate pair is never
split. Uniqueness is checked on the cut handle. A name that gives `""` (no letters or digits) is refused with a reason.
No runtime dependency: maintained slug libraries either fold Unicode to ASCII or pull in a large character table, and
this rule is a few lines.

Today's `slug()` for attribute keys, relation names and schema slots is untouched. A test pins its output on a fixture
of existing keys.

### Create and update

- `remember` **without `id` creates**. A new record needs a `label`; its handle is `handleOf(label)`, and its internal
  id is minted as before.
- When the handle is taken, the create fails with stage `"handle"`. `holder` gives the holding record's `{ id, handle,
  label, type, holds }`, and the message tells the agent to update that record by its handle or to qualify the name
  ("Sam (Acme)" → `sam-acme`). `holds` is one of:
  - `current`: another record's current handle.
  - `earlier`: a renamed record's old handle.
  - `forgotten`: a forgotten record's handle.
  - `id`: another record's internal id.
  - `unmigrated`: the name of a record saved before handles.
- **Replay:** if the holder's current view already holds everything the create says, the create succeeds with the
  holder (`replayed: true`). eve re-runs a step interrupted mid-write, so a save can arrive twice.
- `remember` **with `id` updates**. `id` goes through the resolver. A miss fails with suggestions; it never creates under
  an agent-chosen id, because a misspelled handle would otherwise mint a second record. An `id` that resolves to a
  forgotten record brings that record back under its own id and handle.
- **Rename:** an update that changes `label` gives the record the handle of its new name. That fails the same way
  when another record holds the handle, and writes nothing when the record already holds it (renaming back).
- `relations[].to` and `forget`'s `id` resolve the same way. A connection to a miss or to a forgotten record fails; the
  internal id is what's stored.

### Resolver: `MemoryGraph.resolve(ref): Resolution`

`ref` is `knowledge:<x>` or `<x>`. Steps, first match wins:

1. Current handle.
2. Earlier handle.
3. Internal id, exactly. Then, only for input in `[A-Za-z0-9_]`, the id `slug()` makes from it, so a reference
   written in another case resolves as it did in 0.5. `slug()` never sees other scripts: it would turn "李明" into
   `x`.
4. The handle `handleOf(x)` makes, as a normalisation of steps 1–2.

Then it follows "merged into" (bounded, cycle-safe). It answers:

- `{ status: "found", id, handle?, via, mergedFrom? }`
- `{ status: "forgotten", id, handle?, on }`: a reference never lands on a newer record.
- `{ status: "missing", suggestions }`: up to three nearest `knowledge:` references, ranked by edit distance over a
  bounded set of candidates (records sharing a word or a first letter), as git ranks "did you mean".

Each scope is its own graph, so **a handle is unique per scope, and resolves only in the scope that wrote it.**
`describe(ref)` and `history(ref)` resolve too, so a host that answers `knowledge:` links with `describe` needs no
change.

### Surfaces and tools

Each record's `knowledge:<handle>` appears on every surface: turn-start lines, `recall`, `relate` and each connection,
`check_memory`, and `remember`'s reply. A record without a handle shows `knowledge:<id>`. `Fact`, `RelateResult` and
`Description` gain `handle`, and connections gain `id` and `handle`. A new tool, **`get({ handle })`**, opens one
record with its details and connections. The behaviour follows the MCP server's `open_nodes`; it isn't called `open`
because `working__open` creates. The descriptions route a known handle to `get` and words to `recall`. Past
`maxCharacters`, the turn-start block drops whole record lines with a note, never cutting a handle in half.

### Operator verbs on `MemoryGraph` (not tools: an agent can't reclaim or merge by accident)

- `mintHandle(id)`: gives a record the handle its current name makes (a forgotten record's, its last name's). A no-op
  when the record already holds it; fails naming the holder when another record holds it or another record's id
  equals it. It doesn't check names of other records saved before handles: settling namesakes among old records is
  the caller's.
- `reclaimHandle(handle)`: frees an earlier or forgotten handle for the next record named for it, as a page move over
  a redirect does. A live record's current handle can't be reclaimed.
- `merge(duplicate, into)`: records that two records are one thing, and retracts the duplicate in the same write.
  A merged page becomes a redirect: the duplicate's rows are tombstoned with the merge's origin, so it stops being
  recalled. Its handles, id, and connections to it lead to `into`, and no edge or reference is rewritten. Left live,
  a duplicate would still be recalled while every reference to it, a forget included, landed on `into`. Carry
  details worth keeping over first. `revertBatch` on the merge's origin brings the duplicate back. Self-merges and
  cycles are refused.

## Storage and invariants

- **Table:** `handles(seq, kind 'handle'|'reclaim'|'merge', handle, s, target, written_at, origin, superseded_by)`,
  with `UNIQUE(handle) WHERE kind = 'handle' AND superseded_by IS NULL`: one live holder per handle string, covering
  current, earlier and forgotten handles.
- **Written with the record:** handle rows are written in the same transaction as the record's triples, carrying the
  same `origin`.
- **Uniqueness under concurrency:** `remember` validates across `await`s outside that transaction, so two same-name
  creates can both pass the pre-check. The losing transaction hits the unique index, rolls back whole, and is
  answered as a replay or as create-fails. One process, two concurrent creates: one record.
- **One in-place change:** `superseded_by` is the store's only in-place change to an attributed row (against the log's
  "never overwrites"), set only by `reclaimHandle`. One live holder per handle has to be a constraint, which an
  append-only log can't express.
- **History and revert:** `history` lists handle, reclaim and merge rows with their origins, under keys a detail can't have (`record handle`, `handle reclaimed`, `merged into`). `revertBatch` deletes them
  by origin like any row, and undoing a reclaim makes the handle its earlier holder's again. A revert that would leave
  a record answering to a handle another record now holds (undoing a rename or a reclaim after the name moved on)
  isn't applied: it rolls back and returns `conflicts: [{ id, handle, heldBy }]`. Reverting a run that gave records
  their first handles is not a conflict.
- **Handles are not attributes:** they never enter the triples, so they stay out of the attribute view, lint input,
  the search index and the fact count by construction. `eve-memory-stats` reports `handles=<n>` on its own.

## Upgrading a store

Opening a store from before 0.6.0 creates the table and moves `user_version` to 5. **It gives no record a handle,
lazily or eagerly:** not on open, not on a rename. Two old records can share a name, and settling that is the
operator's. Until a record has a handle it shows, and resolves, by its id. A new save whose handle equals what an
unmigrated record's current name would make fails and names that record. It's read-only detection: it scans only
records without a live handle, so it's empty once a store is migrated. An upgraded store should be given its handles
with `mintHandle` (and `merge` for duplicates) before agents write to it.

## Not built

- No type in a handle: classification changes, and names shouldn't ("Cool URIs don't change").
- No automatic "different thing with the same name" detection: the writer qualifies the name, as Wikipedia's
  parenthetical qualifiers do.
- No change to any existing id, and no rewrite of the log or of any referrer.
- No replay protection by call id: the handle plus the identical-content replay covers the only failure observed.
- No alias machinery beyond handle history.
- **Known residual: homoglyphs.** Preserving Unicode makes `аlice` (Cyrillic `о`) a different handle from `alice`.
  Nothing has been observed; nothing is built.
