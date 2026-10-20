# Eve-Plus Memory

A memory provider for [eve](https://github.com/vercel/eve) — a W3C SHACL ontology over an embedded, disk-backed SQLite graph, exposed to your agent as plain-language tools. The agent owns and shapes its own memory freely; the only gate is whether a write validates against the schema.

## Why

Most agent memory is a flat key-value or vector store: the agent can save things, but nothing stops it from saving nonsense, and nothing surfaces what it isn't allowed to save. This provider inverts that. The agent extends its own schema at runtime — typed entities, required fields, relations — by authoring SHACL shapes, and every write, the agent's own or content it's filing on a user's behalf, is validated against that schema before it lands. A rejected write comes back as a structured, actionable message ("A Room requires a 'floor'"), not a bare error, so the agent corrects itself instead of routing around the store.

## Install

```sh
npm install @eve-plus/memory
```

> Installing from a local checkout or a `file:` dependency? `pnpm` doesn't run a `file:` dependency's `prepare` script, so build the package first (`npm run build` in this repo) before your agent tries to import it. A git or registry install runs `prepare` automatically — no extra step needed there.

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
  }),
  scope: byPrincipal,
  visibility: "scope",
});
```

## Tools

The agent gets a small tool surface; it never sees RDF or SPARQL — this package maps natural language to the graph and back internally.

- **`recall`** — "what do I know about X." Returns matched entities with their attributes.
- **`remember`** — "record Z." Writes a new fact or entity, recorded with who wrote it (see Security below).
- **`relate`** — "what's connected to Y." Returns an entity's relations, plus its own attributes.
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

Records aren't currently enumerable by kind — you can ask "what do I know about Acme Corp" but not yet "list all my clients." A zero-hit search reports that a miss isn't proof of absence, rather than claiming nothing is stored; enumeration-by-kind is on the roadmap.

## Security

Memory is attributed and revertable. It is not a defense against poisoning, and nothing in it decides whether a fact is true.

**What's built:**

- **Every write lands, recorded with who made it.** Each fact and schema change records, from eve's own session context and never from anything the model says: whether it came from the scope owner's own live conversation, another principal's, a scheduled run or a delegated task; the principal; and the session, turn and tool call. A scope that isn't one principal's (a list, or a shared key) has no owner. `history` keeps every replaced value.
- **Recall says who recorded a value.** Tool reads show each value as recorded during the memory owner's own conversation, by a scheduled run, by a delegated task, or during a conversation with someone other than the memory owner, with the date. The turn-start block marks only values that weren't recorded in the owner's conversation, to keep it short. Nothing is rendered as "the user said" or "unconfirmed": the store knows who wrote a value, not whether it's true.
- **Undo by origin.** `MemoryGraph` (exported from the package; open a scope's store with `MemoryGraph.create({ dir: "<dir>/<slugged scope key>" })` while the agent is stopped) has `history` and `revertBatch`. `revertBatch` takes any recorded origin field, so "everything that scheduled run wrote" (`{ who: "scheduled", sessionId }`) or one tool call (`{ callId }`) comes out in one step.
- **One control-plane rule.** Once a record type has been created or extended in the owner's own conversation, only the owner's conversation can change it, and a record typed there can be re-typed only there. Otherwise another writer could change a type so the owner's own saves fail lint. Types and record types written before 0.3.0 (except those 0.2.x recorded as scheduled or delegated), and types a raw shape names (added through the API, never by the tools), count as the owner's. New types and records are open to any writer, values are never protected, and a refused change says why.
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

See [CHANGELOG.md](./CHANGELOG.md). 0.3.0 removes 0.2.x's precedence and the model's `source` field; read it before upgrading.

## Testing this package

- `npm test` — unit + integration suite (`test:unit` runs in-memory; `test:integration` runs on-disk stores through the memory contract).
- `npm run mutate` — mutation testing; each guard is proven to actually catch the bug it claims to guard, not just counted green.

See [`docs/usage.md`](./docs/usage.md) for a tool-by-tool walkthrough with worked examples.

## License

Apache-2.0, matching eve.
