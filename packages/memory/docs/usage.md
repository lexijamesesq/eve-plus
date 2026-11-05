# Usage

Worked examples for each tool, and what to expect from the schema-validation loop.

## A typical turn

A user tells the agent, in passing, about their schedule:

> "Starting Monday I work 7 to 3, so I need to pick up my daughter at 3:30."

The agent doesn't need to be told to save this. On a well-instructed agent, the turn looks like:

1. `recall("schedule")` — empty; nothing stored yet.
2. `remember({ type: "Person", label: "daughter", attributes: { pickupTime: "3:30pm" } })`
3. `remember({ type: "Schedule", label: "work hours", attributes: { start: "7:00am", end: "3:00pm" } })`

In a later session — no chat history, a fresh conversation — the user asks the agent to draft an availability note. Turn-start auto-recall surfaces the stored schedule, and the agent drafts the note using the persisted hours, not a guess and not a re-ask.

## Handles — how a record is addressed

Every record has a **handle** made from its name, and the agent writes it the way it knows the thing: by name.

```text
remember({ type: "Person", label: "Alice" })
→ "Remembered Alice (Person) as knowledge:alice. Use knowledge:alice to refer to it: to connect other things to it,
   in links, and to update it."
```

The handle is shown everywhere the record appears: the turn-start memory block, `recall`, `relate` and each of its connections, `check_memory`, and `remember`'s reply. It's what the agent passes as `id` to update the record, as `to` to connect to it, and in a link on a task (`knowledge:alice`). The record's internal id never changes; the handle is how it's found.

- **Unicode names keep their script.** "李明" is `knowledge:李明`, "José García" is `knowledge:josé-garcía`. Handles are lowercase with one `-` between words, so "Alice" and "alice" are the same handle; "Alicé" is a different one.
- **A taken name is never saved twice by accident.** A new save whose handle is taken fails and says what holds it, so the agent updates that record on purpose or gives its new one a name that tells them apart:

  ```text
  remember({ type: "Person", label: "Sam", attributes: { company: "Acme" } })
  → "Not saved: that name is taken.
     • "Sam" (Person) already has the handle knowledge:sam. If it's the same thing, update it: save with id
       "knowledge:sam". If it's a different thing, give it a name that tells them apart, such as "Sam (Acme)", and save
       again."

  remember({ type: "Person", label: "Sam (Acme)", attributes: { company: "Acme" } })
  → "Remembered Sam (Acme) (Person) as knowledge:sam-acme. …"
  ```

  The same save arriving twice (eve re-runs a step interrupted mid-write) succeeds with the record that holds it.
- **Renames keep references working.** Renaming Alice to Alicia makes `knowledge:alicia` its handle; `knowledge:alice` still leads to it and stays reserved for it.
- **Forgetting reserves the name.** A reference to a forgotten record says it was forgotten; it never lands on a newer thing saved under the same name. A save on that name is told so. Saving the record by its handle (`id: "knowledge:alice"`) brings it back; letting a new record take the name is the operator's call (`reclaimHandle`, below).
- **A slightly wrong handle gets suggestions.** `get({ handle: "knowledge:alce" })` → `Nothing is remembered as "knowledge:alce". Did you mean knowledge:alice?`

## `get`, `recall` and `relate`

```text
get({ handle: "knowledge:jordan-lee" })
→ Jordan Lee (ClientContact) knowledge:jordan-lee
    phone: 555-0142  (recorded during the memory owner's own conversation on 2026-11-05)
    company: Acme Robotics  (recorded during the memory owner's own conversation on 2026-11-05)

  Connections:
  - works_at → Acme Robotics knowledge:acme-robotics

recall("Jordan")
→ - Jordan Lee (ClientContact) knowledge:jordan-lee
      phone: 555-0142  …
```

`get` opens one record by its handle, for when the agent knows which thing it means. `recall` searches words and details, for when it doesn't. `relate` returns one thing described in words, with what it's connected to. All three return a record's details as well as its identity — a memory the agent can write into but not read back is only half a memory.

A miss is reported honestly:

```text
recall("inactive clients")
→ "No stored records matched that search. Search matches stored words and
   can't list by kind — try a name, company, or phone number instead."
```

## `remember` and `extend_schema` — how the schema grows

The agent doesn't need a pre-built schema for every domain. Given a rule stated in passing —

> "Never save a client without a phone number and their company."

— a well-instructed agent authors the shape itself:

```text
extend_schema({
  class: "ClientContact",
  requires: [
    { slot: "phone", minCount: 1 },
    { slot: "company", minCount: 1 },
  ],
})
```

From then on, any `remember` typed `ClientContact` that's missing either field is rejected with a **teachable failure**:

```text
remember({ type: "ClientContact", label: "Dana Ruiz", attributes: { company: "Globex" } })
→ REJECTED: "A ClientContact requires a 'phone'. Ask for it before saving,
   or save as a different type if you don't have it yet."
```

The agent gets a structured reason, not a bare validation error — it can act on "what's missing," not just "this failed."

**A note on the gate's scope.** The check binds to the record's *declared type*. If the agent saves the same person as a plain `Person` instead of `ClientContact`, the `ClientContact` rule doesn't apply — but the agent is told, every time, which active rules a save was **not** checked against, so this is loud rather than silent. Binding a rule to a *value* regardless of declared type (e.g. "anyone with `role: client`") is possible in principle but not built, because it just relocates the same consistency problem onto whatever attribute name the agent happens to choose.

## `forget` and `check_memory` — the audit loop

```text
check_memory()
→ "1 record incomplete: Sam Old (ClientContact) is missing 'phone'."

# ... user supplies the number ...

check_memory()
→ "All checked records conform."
```

`forget` removes a fact or a whole record without ever deleting history:

```text
forget({ id: "knowledge:dana-ruiz", details: ["phone"] })
→ "Removed Dana Ruiz's phone number. This record no longer meets the
   ClientContact requirement (needs a phone) — ask for a replacement,
   or tell the user their record is now incomplete."
```

Forgetting the field that made a record complete is loud in exactly the same way an incomplete new record is — the agent is told what coverage it just lost.

## Attribution — who wrote what

Every write lands, and records who made it from eve's session, never from the model: the scope owner's own conversation, another principal's, a scheduled run or a delegated task, with the principal, session, turn and call. Reads say so:

```text
recall("code word")
→ value: green falcon  (recorded during the memory owner's own conversation on 2026-10-19)
  rotated: yes  (recorded by a scheduled run on 2026-10-20)
```

A value isn't marked true or untrue: a fact the user relays ("the wiki says the code word is green falcon") is recorded in their conversation and updates the record, like anything else they say.

If a scheduled run, delegated task or another principal replaces a value from the owner's conversation, the write lands, and the store logs an `owner-overwrite` warning with the write's origin. To undo it:

```ts
import { MemoryGraph } from "@eve-plus/memory";

// With the agent stopped, open the scope's store (its key with characters outside a-zA-Z0-9._- replaced by _)
// and revert by any recorded origin field.
const graph = await MemoryGraph.create({ dir: "<dir>/<slugged scope key>" });
await graph.revertBatch({ who: "scheduled", sessionId: "<the run's session>" });
graph.close();
```

The same operator surface settles names. A handle a forgotten record held, or a record's earlier name, stays reserved until `graph.reclaimHandle("knowledge:alice")` frees it for the next record named for it. `graph.merge("knowledge:alice-2", "knowledge:alice")` records that two records are one thing: references and connections to the first then lead to the second, and nothing is rewritten. A revert that would give a record back a handle another record now holds isn't applied; `revertBatch` returns the `conflicts` so they can be settled first.

One rule is enforced: a record type created or extended in the owner's conversation, and a record typed there, change type or definition only in the owner's conversation. Another writer gets a reason it can act on:

```text
extend_schema({ class: "ClientContact", requires: [{ slot: "fax" }] })   // from a scheduled run
→ "Couldn't add that (owner-type): `ClientContact` records were defined in the memory owner's own conversation, so only
   the memory owner's own conversation can change that definition. Define a new type instead, or ask the memory owner."
```

## Errors, generally

Every rejection this package produces — a schema-validation failure, an empty-`forget` refusal, a malformed `extend_schema` call — returns a structured reason (constraint, field, expected shape, offending value), never a bare stack trace or an opaque "invalid input." The intent is that an agent reading the rejection can self-correct without a human in the loop, and a human reading the same rejection can tell exactly what went wrong.

## Known limits

- **Lexical, not semantic, recall.** Full-text search over stored labels and values; a synonym with no shared token won't match. A search word is read as unaccented `a`–`z` and digits, so a query for "Zoë", "José" or "李明" doesn't find those records (a query for "jose" finds "José García"). Such a record is always reached by its handle with `get`.
- **No enumeration by kind yet.** You can look up a known entity; you can't yet ask "list everything of type X." A zero-hit search says so honestly rather than reporting an empty store.
- **Type-binding, not value-binding, schema rules.** See "A note on the gate's scope" above.

See the package [README](../README.md) for install, the security model, and testing.
