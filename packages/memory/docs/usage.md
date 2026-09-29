# Usage

Worked examples for each tool, and what to expect from the schema-validation loop.

## A typical turn

A user tells the agent, in passing, about their schedule:

> "Starting Monday I work 7 to 3, so I need to pick up my daughter at 3:30."

The agent doesn't need to be told to save this. On a well-instructed agent, the turn looks like:

1. `recall("schedule")` — empty; nothing stored yet.
2. `remember({ type: "Person", label: "daughter", attributes: { pickupTime: "3:30pm" }, source: "user" })`
3. `remember({ type: "Schedule", label: "work hours", attributes: { start: "7:00am", end: "3:00pm" }, source: "user" })`

In a later session — no chat history, a fresh conversation — the user asks the agent to draft an availability note. Turn-start auto-recall surfaces the stored schedule, and the agent drafts the note using the persisted hours, not a guess and not a re-ask.

## `recall` and `relate`

```
recall("Jordan Lee")
→ { id: "...", label: "Jordan Lee", type: "ClientContact",
    attributes: { phone: "555-0142", company: "Acme Robotics" } }

relate("Jordan Lee")
→ { id: "...", label: "Jordan Lee", type: "ClientContact",
    attributes: { phone: "555-0142", company: "Acme Robotics" },
    relations: [] }
```

Both tools return an entity's attributes as well as its identity — a memory the agent can write into but not read back is only half a memory, so neither tool stops at `{id, label, type}`.

A miss is reported honestly:

```
recall("inactive clients")
→ "No stored records matched that search. Search matches stored words and
   can't list by kind — try a name, company, or phone number instead."
```

## `remember` and `extend_schema` — how the schema grows

The agent doesn't need a pre-built schema for every domain. Given a rule stated in passing —

> "Never save a client without a phone number and their company."

— a well-instructed agent authors the shape itself:

```
extend_schema({
  type: "ClientContact",
  requires: ["phone", "company"],
})
```

From then on, any `remember` typed `ClientContact` that's missing either field is rejected with a **teachable failure**:

```
remember({ type: "ClientContact", label: "Dana Ruiz", attributes: { company: "Globex" } })
→ REJECTED: "A ClientContact requires a 'phone'. Ask for it before saving,
   or save as a different type if you don't have it yet."
```

The agent gets a structured reason, not a bare validation error — it can act on "what's missing," not just "this failed."

**A note on the gate's scope.** The check binds to the record's *declared type*. If the agent saves the same person as a plain `Person` instead of `ClientContact`, the `ClientContact` rule doesn't apply — but the agent is told, every time, which active rules a save was **not** checked against, so this is loud rather than silent. Binding a rule to a *value* regardless of declared type (e.g. "anyone with `role: client`") is possible in principle but not built, because it just relocates the same consistency problem onto whatever attribute name the agent happens to choose.

## `forget` and `check_memory` — the audit loop

```
check_memory()
→ "1 record incomplete: Sam Old (ClientContact) is missing 'phone'."

# ... user supplies the number ...

check_memory()
→ "All checked records conform."
```

`forget` removes a fact or a whole record without ever deleting history:

```
forget({ id: "...", details: ["phone"] })
→ "Removed Dana Ruiz's phone number. This record no longer meets the
   ClientContact requirement (needs a phone) — ask for a replacement,
   or tell the user their record is now incomplete."
```

Forgetting the field that made a record complete is loud in exactly the same way an incomplete new record is — the agent is told what coverage it just lost.

## Provenance and approval — filing content on a user's behalf

When a user hands the agent content to file rather than stating facts directly —

> "This came in today — file anything I should keep." *(+ a pasted email)*

— the agent must declare `source: "content"` on anything it saves from it:

```
remember({ ..., source: "content", from: "the pasted email" })
```

Filed-from-content values are marked wherever they're read back:

```
recall("Jordan Lee")
→ attributes: { phone: "555-0199 ⟨unconfirmed — from the pasted email,
    not stated by you⟩" }
```

If that content would **replace** an existing value, create a same-name duplicate, adopt a new schema rule, or **forget a whole record** (always, regardless of who or what asked), the write doesn't land silently — it pauses for the operator's approval via eve's own tool-approval mechanism first. Content can propose; only the user's own word, or their explicit approval of a proposal, changes what the agent treats as ground truth.

## Errors, generally

Every rejection this package produces — a schema-validation failure, an empty-`forget` refusal, a malformed `extend_schema` call — returns a structured reason (constraint, field, expected shape, offending value), never a bare stack trace or an opaque "invalid input." The intent is that an agent reading the rejection can self-correct without a human in the loop, and a human reading the same rejection can tell exactly what went wrong.

## Known limits

- **Lexical, not semantic, recall.** Full-text search over stored labels and values; a synonym with no shared token won't match.
- **No enumeration by kind yet.** You can look up a known entity; you can't yet ask "list everything of type X." A zero-hit search says so honestly rather than reporting an empty store.
- **Type-binding, not value-binding, schema rules.** See "A note on the gate's scope" above.

See the package [README](../README.md) for install, the security model, and testing.
