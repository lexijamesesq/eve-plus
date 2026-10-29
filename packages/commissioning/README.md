# Eve-Plus Commissioning

An [eve](https://github.com/vercel/eve) extension that lets an agent commission software work from another agent, the worker, and talk with it until the work is done. The commissioner opens the work; the worker reads it, asks questions and proposes a change; the commissioner answers and accepts the proposal or asks for a revision. It's built on eve's public extension, tool, channel and schedule seams and uses no eve internals.

The core is worker-neutral. The package ships one connector, for [Cyrus](https://www.atcyrus.com), which hands work off by delegating a Linear issue.

## Install

Install it from a release tag as a git dependency, next to eve 0.83.2 or later within 0.83:

```json
{
  "dependencies": {
    "@eve-plus/commissioning": "github:lexijamesesq/eve-plus#commissioning--v0.5.0&path:packages/commissioning",
    "eve": "0.83.2"
  }
}
```

## Use

Mount it in the commissioning agent, with your worker connector and three callbacks that keep identity and routing in your application:

```ts title="agent/extensions/commissioning.ts"
import commissioning from "@eve-plus/commissioning";
import { cyrus } from "@eve-plus/commissioning/cyrus";
import slack from "../channels/slack";

export default commissioning({
  dataDir: "/data/commissioning",
  namespace: "felix",
  worker: cyrus({
    linear: { accessToken: () => linearToken() },
    delegateId: "<Cyrus's Linear user ID>",
    mcp: { serverName: "eve_felix", endpoint: "https://agent.example/commissioning/mcp" },
  }),
  // Is this request from the worker? Compare its bearer token with the one the worker holds.
  authenticateWorker: (request) => matchesWorkerToken(request),
  // Who may commission, as which commissioner, and which conversation the session is in.
  commissioner: (auth) => commissionerFor(auth),
  // Where to tell the commissioner about a commission: a channel, its target, and the auth to send as.
  deliver: (conversation) => ({ channel: slack, target: { ...conversation }, auth: agentAuthIn(conversation) }),
});
```

[`docs/usage.md`](./docs/usage.md) covers each option, the callbacks' contracts and the Cyrus setup.

## How it works

1. **Open.** The commissioner calls `commissioning__open` with a brief, acceptance criteria and a work reference (a Linear issue for Cyrus). The connector checks the work item, and the commission and its handoff are recorded together. Then the dispatcher hands the work off: for Cyrus, a contract comment on the issue and a delegation, each confirmed by reading it back.
2. **Talk.** The worker calls the mount's MCP endpoint (`/commissioning/mcp`) with three tools: `commission_read`, `commission_consult` to ask a question, and `commission_report` for a checkpoint, a failure or a proposal. A proposal names an exact commit and its pull request.
3. **Hear about it.** What the worker asks, proposes or reports as a failure is delivered into the conversation the commission was opened in, through eve's `to(channel, target)`, as a queued turn. So is an overdue notice when the worker goes quiet past its grace interval.
4. **Decide.** The commissioner reads with `commissioning__read` and records answers and verdicts only with `commissioning__decide`. Saying it in a reply records nothing. The worker finds the answer or verdict on its next `commission_read`.

## What it guarantees

- **Decisions come only from the commissioner.** The worker endpoint has no owner operations. An owner can read or decide a commission only from the conversation it was opened in, as `commissioner(auth)` reports it from verified session auth, never from tool arguments.
- **Retries are safe.** Every question, report and decision carries an ID; a retry with the same ID and content returns the first result, and the same ID with other content is refused. This holds across restarts, past eve's own delivery-key window.
- **Nothing is lost between a write and its notice.** A notice is recorded in the same transaction as the write. The dispatcher delivers it at least once, and a crash after a send and before its acknowledgement sends it again. Entries that keep failing go to the back, so they can't hold up newer ones.
- **Silence is noticed, not judged.** A worker that's working or revising and has been quiet past `overdueAfterMs` gets one notice per quiet spell. A pending question, a proposal under review, blocked work and accepted work aren't the worker's move, so they don't go overdue.

**What it doesn't do:** it doesn't start, restart or cancel the worker. A confirmed handoff means the worker was given the work, not that it started. When a Cyrus session parks or stops, a person continues it in its Linear agent session.

## Storage

One SQLite file per mount, at `<dataDir>/<namespace>/commissions.sqlite`, in WAL mode, read and written by one agent process. Keep it on a durable volume outside the sandbox, and back it up with SQLite's WAL-aware backup or with the agent stopped.

## Changes

See [CHANGELOG.md](./CHANGELOG.md). 0.5.0 is a breaking rework: one worker token in place of signed credentials, delivery into the original conversation, and a single-schema store. Read it before upgrading.

## Testing

- **Unit tests** (`npm run test:unit`) cover the ledger on an in-memory store, the commissioner's tools, and the Cyrus connector against a synthetic Linear API.
- **Integration tests** (`npm run test:integration`) cover the on-disk ledger across restarts and competing handles, the dispatcher's handoff, delivery and retry fairness, and the worker endpoint through the official MCP client.

## License

MIT.
