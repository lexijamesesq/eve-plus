# Changelog

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
