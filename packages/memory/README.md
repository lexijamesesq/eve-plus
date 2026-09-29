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
  provider: shaclMemory({ dir: "./.eve/memory" }),  // where the SQLite store lives on disk
  scope: byPrincipal,
  visibility: "scope",
});
```

## Tools

The agent gets a small tool surface; it never sees RDF or SPARQL — this package maps natural language to the graph and back internally.

- **`recall`** — "what do I know about X." Returns matched entities with their attributes.
- **`remember`** — "record Z." Writes a new fact or entity. Requires a `source` (`user` or `content` — see Security below).
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

Handing an agent open-ended memory raises an obvious question: what happens when a user asks the agent to file content it didn't write itself — an email, a pasted note, anything where the *content*, not the user, is asserting the facts. This package treats that as an adversarial input, not a convenience.

**What's built:**

- **Provenance on every write.** `remember`, `forget`, and `extend_schema` require `source: "user" | "content"`. Values sourced from handed content are marked `⟨unconfirmed⟩` wherever they're surfaced back to the agent, so filed content is never mistaken for something the user stated directly.
- **Approval before consequential acts.** Content-sourced writes that would replace an existing value, create a same-name duplicate, adopt a new schema rule, or forget a whole record all pause for the operator's approval — via eve's own human-in-the-loop tool-approval mechanism — before they land, not after.
- **Memory is shown to the model as data, not instructions.** The per-turn context block presenting the agent's own schema is rendered as a plain listing (type and field names only), never as free-form text that could read as an instruction; a rule author's rejection-message text never reaches the model either. Instruction-shaped authored names are capped (≤3 words, ≤24 characters) on both authoring surfaces — schema authoring via `extend_schema` and entity/attribute naming via `remember`.

**What's measured, stated honestly, not overclaimed:** the caps above bound how much text an attacker can inject through an authored name; they don't eliminate the surface entirely. In the worst case we could construct and seed directly — an attacker-controlled name at the cap, on a benign conversational question — we measured roughly 1 in 8 follow-throughs (4 of 32 trials). Aimed at an actual destructive action rather than a style change, the same class of name was followed 0 times across 64 trials. Realistically this residual doesn't translate into unauthorized harm end to end, because any consequential action still has to clear the approval gate described above — the caps are defense in depth, not the only wall. We're not claiming this residual is neutralized, and we're not shipping a classifier to close it; we're stating the bound plainly and defending the rest at the approval-gate and sandbox layer, where it belongs.

## Testing this package

- `npm test` — unit + integration suite (`test:unit` runs in-memory; `test:integration` runs on-disk stores through the memory contract).
- `npm run mutate` — mutation testing; each guard is proven to actually catch the bug it claims to guard, not just counted green.

See [`docs/usage.md`](./docs/usage.md) for a tool-by-tool walkthrough with worked examples.

## License

Apache-2.0, matching eve.
