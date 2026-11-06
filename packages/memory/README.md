# Eve-Plus Memory

A memory provider for [eve](https://github.com/vercel/eve) — a W3C SHACL ontology over an embedded, disk-backed SQLite graph, exposed to your agent as plain-language tools. The agent owns and shapes its own memory freely; the only gate is whether a write validates against the schema.

## Why

Most agent memory is a flat key-value or vector store: the agent can save things, but nothing stops it from saving nonsense, and nothing surfaces what it isn't allowed to save. This provider inverts that. The agent extends its own schema at runtime — typed entities, required fields, relations — by authoring SHACL shapes, and every write, the agent's own or content it's filing on a user's behalf, is validated against that schema before it lands. A rejected write comes back as a structured, actionable message ("A Room requires a 'floor'"), not a bare error, so the agent corrects itself instead of routing around the store.

## Install

Install it from a release tag as a git dependency, next to eve 0.91.0 or later within 0.91:

```json
{
  "dependencies": {
    "@eve-plus/memory": "github:lexijamesesq/eve-plus#memory--v0.6.0&path:packages/memory",
    "eve": "0.91.0"
  }
}
```

> Installing from a local checkout or a `file:` dependency? `pnpm` doesn't run a `file:` dependency's `prepare` script, so build the package first (`npm run build` in this repo) before your agent tries to import it. A git install runs `prepare` automatically — no extra step needed there.

Register it as an eve memory:

```ts
import { defineMemory } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";
import { shaclMemory } from "@eve-plus/memory";

export default defineMemory({
  namespace: "my-agent-knowledge-v1",              // eve-level, versioned — see Namespacing below
  provider: shaclMemory({
    dir: "./.eve/memory",                           // where the SQLite store lives on disk
    maxWritesPerSession: 200,                       // optional: fail loud past this many writes in one session
    onOpen: (graph, scope) => void graphs.set(key(scope.value), graph), // optional: join this memory to another (see Tools)
  }),
  scope: byPrincipal,
});
```

## Tools

The agent gets a small tool surface; it never sees RDF or SPARQL — this package maps natural language to the graph and back internally.

- **`recall`** — "what do I know about X." Searches words and details; returns matched records with their attributes.
- **`get`** — "open Alice." Opens one record by its handle, with its details and connections.
- **`remember`** — "record Z." Saves a new record (no `id`) or updates one (its handle as `id`), recorded with who wrote it (see Security below).
- **`relate`** — "what's connected to Y." Returns a record's connections, plus its own attributes.

### Handles

Every record has a handle made from its name, and that's how the agent addresses it: "Alice" is `knowledge:alice`, "José García" is `knowledge:josé-garcía`. The handle is on every surface the agent sees a record: the turn-start block, `recall`, `get`, `relate` and its connections, `check_memory`, and `remember`'s reply. The record's internal id never changes.

- Handles keep Unicode letters, are lowercase, use one `-` between words, and are at most 118 characters, so `knowledge:<handle>` fits a link. `handleOf(name)` computes one.
- A new save whose handle is taken fails and names the record that holds it, so the agent updates that record or gives its new one a name that tells them apart ("Sam (Acme)" → `knowledge:sam-acme`). An identical save arriving twice succeeds with the record that holds it. A unique index guarantees one record per handle under concurrent writes.
- A rename keeps the old handle leading to the record. A forgotten record's handle stays reserved, and references to it say it was forgotten. `MemoryGraph.reclaimHandle(handle)` frees one for the next record named for it.
- `MemoryGraph.resolve(ref)` is the one resolver: current handle, then an earlier handle, then the internal id, following merges (`MemoryGraph.merge(duplicate, into)`). Every input that names a record (`remember`'s `id`, a connection's `to`, `forget`) goes through it, and a miss comes back with the nearest handles.
- Each scope is its own graph, so a handle is unique within a scope and resolves only there.

A store from before 0.6.0 gains the handles table on open, but its records get no handles until you give them, so two old records that share a name are never settled without you. `eve-memory-migrate` does it (see [Migrating a store to handles](#migrating-a-store-to-handles)); do it before agents write to the upgraded store. Until then those records show and resolve by their id.

An attribute value may be a reference to another memory, such as `{ loop: "working:L3f" }` for a task in `@eve-plus/working` or `{ about: "knowledge:acme" }` for another record here. It is kept and shown as written, so the agent can follow it. For the other direction, a task that cites a record here, give the provider `onOpen(graph, scope)`. It hands your host each scope's graph as it opens, and `graph.describe(ref)` resolves a `knowledge:<handle>` reference to the one-line answer the other memory shows. The hook may be async; one that throws or rejects is logged and never fails the open.

- **`extend_schema`** — author or extend a record type at runtime (e.g. "a client always needs a phone and a company"). Meta-validated against SHACL-SHACL: the agent can grow the schema, but never the metamodel it's checked against.
- **`forget`** — remove a fact or a whole record. Appends a tombstone rather than deleting in place; nothing is destroyed.
- **`check_memory`** — revalidate an entity against the rules that target it, and report what's missing.

Nothing is ever overwritten or deleted in place: every write is attributed and timestamped, and reads always serve the current (latest) view. That's what makes `forget` and schema changes safely reversible on the operator side (`history` / `revertBatch`), even though the agent's own tools only ever move forward.

## Namespacing

eve's default memory namespace is derived from your application's build path. Building from a different path — a container, a different machine — silently opens a **different, empty** store: the agent won't error, it'll just report it has nothing on record. Always pass an explicit, versioned `namespace` on `defineMemory` (`<agent>-knowledge-v<N>`, as in the registration example above) rather than relying on the default. Bump the version deliberately when you want a fresh store; never let it change as a side effect of where you happen to build from.

This is distinct from `shaclMemory`'s own `dir` option, which just names where the SQLite store lives on disk — get the namespace wrong and you can open the right file but the wrong logical store (or, across a build-path change, a silently empty one).

## Storage

Disk-backed SQLite (`better-sqlite3` + FTS5), not in-memory — `recall` and `relate` add under 5 MB of memory whether the graph holds 10k or 100k triples; it doesn't grow with the graph (3 runs; reproduce with `node --expose-gc bench/ram.mjs`). SQLite's WAL mode gives crash safety for free: a process crash and restart doesn't lose or corrupt data.

Recall is **lexical** (full-text search over stored labels and values), not semantic — a query for "availability" won't match a stored "work hours" unless they share a token. If your use case needs semantic recall, that isn't built here yet.

Search reads a word as unaccented `a`–`z` and digits, so a record named "Zoë", "José" or "李明" isn't found by searching that name; `get` reaches it by its handle.

Records aren't currently enumerable by kind — you can ask "what do I know about Acme Corp" but not yet "list all my clients." A zero-hit search reports that a miss isn't proof of absence, rather than claiming nothing is stored; enumeration-by-kind is on the roadmap.

## Checking a store

`eve-memory-stats <dir>` prints read-only facts about every store under a memory directory, one line per scope:

- the write high-water mark, which never goes down;
- SQLite's integrity check;
- whether the search index matches the current values;
- who owns the files.

Run it before and after something that could lose memory, such as a deploy, an upgrade or a volume move, and
compare the two readings. A lower mark or a vanished scope means the store was lost or replaced. Run it as the
agent's own user. It may create `graph.db-shm` (and an empty `graph.db-wal`), but it never writes the store or the contents of its WAL; run as root, those files would lock the agent out. See
[CHANGELOG.md](./CHANGELOG.md) for each field.

## Migrating a store to handles

`eve-memory-migrate <dir>` gives the records of stores saved before 0.6.0 their handles. A record whose name makes a handle no other record wants gets it. Records whose names make one handle are a **clash**, and a clash is settled only by your decision.

**Dry run.** `eve-memory-migrate <dir> [--report report.json] [--refs refs.txt]` copies each store under `<dir>` and plans on the copy; the store itself is opened read-only and never written. It prints, per scope:

- the counts (`records`, `edges`, `triples`, `handles`);
- each clash as `c1`, `c2`, …, with its handle, its members by id and type, and whether they agree on each detail (`same`, `differs`, `only`), with who wrote them and when. No detail values are printed;
- a proposal (`duplicate`, `namesake` or `unclear`) from the evidence. A record left untyped beside a typed one, an equal value, or a shared connection points to one thing saved twice. Two concrete types, or one-off connections to different places, point to two things. A connection to a record that a quarter or more of the scope's records link to (at least three) counts for nothing. It is only a proposal;
- lettered options for each clash, each tried on the copy, marked if it won't apply and why;
- `knowledge:` references (from `--refs`, one per line, and from the stores' own details) that the upgrade itself breaks, `pin_breaks`: ones 0.5 resolved by a loosely written id that 0.6 doesn't.

`--report` writes the full report, values included, as JSON with mode `0600`. Keep it where only you can read it.

**The options.** Each member of a clash takes one choice, and only one member may end up answering to the bare handle:

- live records: keep the name (`survivor`), merge into the survivor (details only the duplicate holds are carried over first; a detail both hold stays the survivor's unless the decision takes it from the duplicate; type and name are never carried; connections are carried only to records that still resolve, and the result notes any left out), or qualify with a new name ("Sam (Acme)" → `knowledge:sam-acme`), or stay without a handle. A merge the survivor's rules refuse is offered again leaving out the details they refuse;
- forgotten records: `reserve` the name, as forgetting does now, or `release` it to a live record;
- a record whose internal id is the handle keeps it; the others qualify or stay without a handle;
- a merged record written to again under its own id (by a version before 0.6) is reported on its own, to carry what was written since over to its survivor.

**Apply**, with the agents using the stores stopped:

```sh
eve-memory-migrate <dir> --apply --report report.json --choose 'c1=A c2=Q:"Sam (Acme)" c3=D'
eve-memory-migrate <dir> --apply --decisions decisions.json
```

It prints each decision it read, with the handle each new name makes, and checks them against a copy first: a decision that breaks a rule (a new name whose handle is taken, two records keeping one name) refuses the apply before anything is written. It then works in phases across every clash: carry-overs, merges, new names, then handles. A clash whose step fails is reverted alone and the rest go on. A clash with no decision, or that changed since the dry run (a member added, renamed, retyped, or a detail key or connection added), is skipped and reported, and its records keep resolving by their id. References are checked before and after; a write that leaves a reference leading somewhere other than its old target (or that target's survivor) is taken back and reported, including one only 0.5 resolved that a new handle would send to another record. The dry run reports such breaks too, as `migration_breaks`, from trying the clash-free handles on its copy. Every write carries the run's origin (`{ source: "migration", run }`, written as unattributed, never as the owner), so `MemoryGraph.revertBatch({ run })` undoes a run, and `{ run, clash }` one clash. The result line gives the merges, handles minted, rows written and rows reverted, so `eve-memory-stats` before and after reconciles: records go down by the merges, triples up by the rows written (counted after any reverts), and handles up by those minted.

A re-run picks up where a stopped one left off: merged records drop out of the plan, giving a handle again is a no-op, and a carry-over that landed without its merge still matches its decision. It exits 0 when it ran, whatever each clash's outcome, 1 when it refused before writing, and 2 on bad usage.

## Security

Memory is attributed and revertable. It is not a defense against poisoning, and nothing in it decides whether a fact is true.

**What's built:**

- **Every write lands, recorded with who made it.** Each fact and schema change records, from eve's own session context and never from anything the model says: whether it came from the scope owner's own live conversation, another principal's, a scheduled run or a delegated task; the principal; and the session, turn and tool call. A scope that isn't one principal's (a list, or a shared key) has no owner. `history` keeps every replaced value.
- **Recall says who recorded a value.** Tool reads show each value as recorded during the memory owner's own conversation, by a scheduled run, by a delegated task, or during a conversation with someone other than the memory owner, with the date. The turn-start block marks only values that weren't recorded in the owner's conversation, to keep it short. Nothing is rendered as "the user said" or "unconfirmed": the store knows who wrote a value, not whether it's true.
- **Undo by origin.** `MemoryGraph` (exported from the package; open a scope's store with `MemoryGraph.create({ dir: "<dir>/<slugged scope key>" })` while the agent is stopped) has `history` and `revertBatch`. `revertBatch` takes any recorded origin field, so "everything that scheduled run wrote" (`{ who: "scheduled", sessionId }`) or one tool call (`{ callId }`) comes out in one step.
- **One control-plane rule.** Once a record type has been created or extended in the owner's own conversation, only the owner's conversation can change it, and a record typed there can be re-typed only there. Otherwise another writer could change a type so the owner's own saves fail lint. Types and record types written before 0.3.0 (except those 0.2.x recorded as scheduled or delegated), and types a raw shape names (added through the API, never by the tools), count as the owner's. New types and records are open to any writer, values are never protected, and a refused change says why. A scope that isn't one principal's (a list or a shared key) has no owner, so the rule doesn't apply there.
- **Detection, not gates.** When a scheduled run, a delegated task or another principal replaces or retracts a value written in the owner's conversation, the write lands and is logged as one `[mem] owner-overwrite` warning with its origin, and counted: the warning carries the running count for that store since the process started (`owner-overwrite #3`). The optional `maxWritesPerSession` caps write calls per session: past it, a write throws instead of landing, so a run that goes wrong can't rewrite a whole memory.
- **Memory is shown to the model as data, not instructions.** The per-turn context block presenting the agent's own schema is rendered as a plain listing (type and field names only), never as free-form text that could read as an instruction; a rule author's rejection-message text never reaches the model either. Instruction-shaped authored names are capped (≤3 words, ≤24 characters) on both authoring surfaces — schema authoring via `extend_schema` and entity/attribute naming via `remember`.

**The name caps are a heuristic, measured:** they bound how much text an attacker can inject through an authored name; they don't eliminate the surface. In the worst case we could construct and seed directly — an attacker-controlled name at the cap, on a benign conversational question — we measured roughly 1 in 8 follow-throughs (4 of 32 trials). Aimed at an actual destructive action rather than a style change, the same class of name was followed 0 times across 64 trials.

**Named residuals:**

- **Content in the owner's own turn can change facts.** Text the user pastes or forwards arrives in their own message, and no signal separates it from their words, so whatever the agent saves from it is recorded as written in the owner's conversation. Attribution finds it; `revertBatch` undoes it.
- **Memory steers answers.** A wrong value, whoever wrote it, shapes what the agent says next. Recall says who recorded it, not whether it's true.
- **No cryptographic integrity.** Origins are rows in a SQLite file. Anyone who can write the file can rewrite them, which is acceptable where the store sits on one operator's own volume.
- **Retention is deferred.** Nothing expires: replaced values stay in history until a scope is reset.

**Resetting one scope** (the operator who runs the agent's host does this): stop the agent and move `<dir>/<scope key>/` aside (the scope key with characters outside `a-zA-Z0-9._-` replaced by `_`); that scope starts empty on its next use, and the moved copy can be restored.

## Changes

See [CHANGELOG.md](./CHANGELOG.md). 0.6.1 adds `eve-memory-migrate`. 0.6.0 adds handles and makes `remember`'s `id` update-only; read its upgrade note before upgrading. 0.4.0 adds the write high-water mark and `eve-memory-stats`. 0.3.0 removes 0.2.x's precedence and the model's `source` field; read it before upgrading from 0.2.x.

## Testing this package

- `npm test` — unit + integration suite (`test:unit` runs in-memory; `test:integration` runs on-disk stores through the memory contract).
- `npm run mutate` — mutation testing; each guard is proven to actually catch the bug it claims to guard, not just counted green.

See [`docs/usage.md`](./docs/usage.md) for a tool-by-tool walkthrough with worked examples.

## License

Apache-2.0, matching eve.
