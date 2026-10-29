# Usage

How to set up a commissioning mount and a Cyrus worker, and what each side sees.

## Options

| Option | What it is |
| --- | --- |
| `dataDir` | Absolute directory for the ledger, on durable storage outside the sandbox. |
| `namespace` | The ledger's subdirectory, lowercase, up to 64 characters. One per mount. |
| `worker` | The worker connector, such as `cyrus(...)`. |
| `authenticateWorker(request)` | Returns `true` when a request to the worker endpoint comes from the worker. Anything else, a throw included, is a 401. |
| `commissioner(auth)` | Returns `{ id, conversation }` for a session that may commission, or `null`. |
| `deliver(conversation)` | Returns `{ channel, target, auth }`: where to tell the commissioner, and as whom. |
| `overdueAfterMs` | How long the worker may be quiet before the commissioner is told. Default 60,000. |
| `reconcileCron` | The reconcile schedule's cron. Default every minute. |
| `mcpPath` | The worker endpoint's path. Default `/commissioning/mcp`. |

## The callbacks

They keep identity and routing in your application; the package never derives them itself.

**`authenticateWorker(request)`** checks the worker's credential. With one long-lived token held by both sides, extract the bearer with eve's `extractBearerToken` (`eve/channels/auth`) and compare it in constant time with `crypto.timingSafeEqual`. A worker authenticated here can read a commission, ask and report, and nothing else: the endpoint has no owner operations.

**`commissioner(auth)`** maps a session's verified auth to who commissions and where. `id` names the commissioner: several principals can share one, such as the operator and a schedule both acting for Felix. `conversation` is your own coordinates for the conversation the session is in, 1 to 16 string fields: for Slack, the team, channel and thread; for a Linear agent session, the organization, session and issue. Read them from `auth`, never from anything the model wrote. It's called on every owner tool call: an owner can act on a commission only when `id` matches and `conversation` equals the one recorded at open. Return `null` for the worker's own principal and for anyone who may not commission.

**`deliver(conversation)`** names where a notice goes for a commission opened in `conversation`: one of the agent's channels, a target on it, and the auth to send with, usually the agent's own principal in that conversation. The dispatcher sends the notice with `to(channel, target).send(notice, { auth, turnPolicy: "queue" })`, so it waits for any turn already running. Before sending, it checks that `commissioner(auth)` returns the commission's own `id` and `conversation`. A delivered turn that couldn't act on the commission would be a notice nobody can answer, so a delivery that fails the check stays pending.

## The commissioner's tools

- **`commissioning__open`**: `{ spec: { brief, acceptance }, workReference }`. Opens one commission per tool call: a retry of the same call opens the same one, and the connector prepares the work only the first time.
- **`commissioning__read`**: `{ commissionId }`. The status, whether the handoff is confirmed, the worker's questions and their answers, the current proposal and an overdue notice, in plain language.
- **`commissioning__decide`**: answers a question (`target: "question"`, `questionId`, `decision: { answer }`) or decides the pending proposal (`target: "proposal"`, `proposalId`, `decision: { verdict: "accept" | "revise", feedback }`). Each decision has its own `eventId`. A proposal can't be decided while a question is unanswered, and only the current proposal can be decided.

Refusals come back as a sentence the agent can act on, such as "Couldn't record the decision: Decide the current pending proposal." A failed delivery attempt logs `[commissioning] delivery failed: commission=<id> reason=<reason> attempt=<n>`.

## The worker's tools

At the mount's MCP endpoint, stateless Streamable HTTP:

- **`commission_read`**: `{ commissionId, after? }`. The commission, its questions, the current proposal and its events after a cursor. Poll it for answers and verdicts.
- **`commission_consult`**: `{ commissionId, questionId, question: { text, options? } }`.
- **`commission_report`**: `{ commissionId, eventId, kind, data }`, where `kind` is `checkpoint` (work is under way), `failure` (blocked), or `proposal` with `data.artifact: { repository, commit, pullRequest }`. The repository and PR are credential-free HTTPS URLs, the PR belongs to the repository, and `commit` is the full lowercase 40-hex commit.

A result is `{ result, recorded: true }`, or `{ error: { code, message } }` with one of the store's own codes (`invalid_input`, `not_found`, `forbidden`, `conflict`, `stale_proposal`); anything unexpected is `internal`, with no detail.

## Cyrus

`cyrus({ linear, delegateId, mcp, timeoutMs? })` hands work off through Linear:

- `linear.accessToken`: a token, or a function that returns the current one, for an app that can comment on and delegate issues. `linear.fetch` and `linear.signal` are optional.
- `delegateId`: Cyrus's Linear user ID.
- `mcp.serverName` and `mcp.endpoint`: the name Cyrus's MCP configuration gives this mount, and the URL Cyrus reaches it at (HTTPS, or HTTP on this host only).
- `timeoutMs`: the deadline for each Linear operation. Default 15 seconds.

**The handoff.** `open` reads the issue: it must have no delegate and no commissioning contract yet, meaning no comment and no description containing `## Commissioning contract`. The dispatcher then adds one root comment holding the commission's contract (its ID, the server name and endpoint, the brief and the acceptance criteria), reads it back, sets only the delegate, and reads that back. It never edits the issue's description or another comment. A lost response is reconciled by reading the issue before retrying. Linear has no compare-and-swap on delegation, so use an issue dedicated to the commission.

**Cyrus's side.** Cyrus needs the endpoint in its MCP configuration with the worker token as a header, read from its environment rather than written into the file:

```json
{
  "mcpServers": {
    "eve_felix": {
      "type": "http",
      "url": "https://agent.example/commissioning/mcp",
      "headers": { "Authorization": "Bearer ${COMMISSIONING_WORKER_TOKEN}" }
    }
  }
}
```

Allow exactly `mcp__<server>__commission_read`, `mcp__<server>__commission_consult` and `mcp__<server>__commission_report` alongside Cyrus's own tools, and give it instructions to look for the contract comment on a delegated issue before starting (a comment headed `## Commissioning contract`, whose next line is `Commission ID: <id>`), read the commission, and use the three tools.

**When Cyrus stops.** Cyrus polls `commission_read` while it's running. Once its session parks or exits, nothing here wakes it: a person replies in its Linear agent session, or starts a fresh session on the same issue, which reads the commission first. The overdue notice is how the commissioner learns it's gone quiet.

## Writing your own connector

A connector is `{ id, prepare, handoff }`. `prepare({ commissionId, reference })` checks the work item without changing anything and returns a small record of string fields, which is stored with the commission. When it fails for a reason that may pass, such as the work system being unreachable, reject with an error carrying `retryable: true`: `open` then tells the commissioner to try again and logs `[commissioning] work preparation failed: commission=<id> reason=worker_unavailable`. Any other rejection refuses the work reference. `handoff({ commissionId, spec, binding })` makes the handoff and resolves only once it's observed; an uncertain outcome must reject, so the dispatcher retries it. Keep `id` stable: a pending handoff recorded under one `id` isn't sent through another.
