# Cyrus connector

The optional `@eve-plus/commissioning/cyrus` module supplies supported work handoff and native worker setup for a configurable, self-hosted Cyrus installation. The core stays worker-neutral. Credentials, accounts, repository access, authorized operators and deployment remain consumer configuration. Hosted offerings without custom MCP/instruction configuration are not qualified by this connector.

This candidate targets released Cyrus/ClaudeRunner 0.2.73 and the SDK resolved by the portable probe. Compatibility requires current-candidate evidence, not an old private-host receipt or a version label.

## Configuration and handoff

Pass `cyrus({linear: {accessToken}, delegateId, mcp: {serverName, endpoint}})` as the commissioning mount's `worker`. `accessToken` may be a string or current-token callback; optional standard `fetch`, cancellation signal and request timeout support application integration. The complete [reference consumer](../examples/cyrus/README.md) supplies those inputs without a private identity module.

The Linear delegate and core worker principal are independently configured identities. The MCP endpoint must be worker-reachable. Server name, endpoint, delegate and a prepared contract-comment UUID enter the immutable binding; configuration changes cannot silently redirect existing work.

Open with `workReference: {kind: "linear-issue", id: "ENG-123"}`. A work issue is separate from the commissioner's originating conversation. The connector resolves its canonical ID/URL through the supplied Linear access.

For an unassigned issue, append one worker-redacted contract as a new root comment using its prepared UUID, confirm its exact body on the canonical issue, then set only the delegate and confirm both by readback. The connector never rewrites the issue description or an existing comment. Identical comment/delegate state is replay success without another mutation. Response loss is reconciled by the persisted comment ID, exact body and canonical issue; unavailable readback remains pending. A foreign, modified, duplicate or deleted contract, another delegate, or an existing Cyrus assignment without our matching comment requires investigation rather than overwrite. A bounded server-side query selects the prepared ID or any commissioning marker; extra matches or further matching pages conflict without scanning unrelated history.

The connector supports at most 1,048,576 characters (JavaScript string length) in the complete rendered contract, including its protocol/header and acceptance formatting. This local connector/readback bound is not a statement of Linear's service quota. An oversized contract fails with the fixed `contract_too_large` reason before handoff performs any provider read or write; the commissioner must reduce the work specification rather than retry unchanged. Read-only preparation may already have resolved the issue before the full work specification is available to handoff.

The unreleased description-based binding format is not reinterpreted. New bindings use version 2; drain prior manual/experimental activation or recreate the isolated proving-ground ledger before selecting the new connector. Do not edit a persisted binding to retarget live work.

Use a dedicated work issue owned by the commissioning flow during enrollment. Independent concurrent commissioning writers are unsupported. Linear exposes no delegation compare-and-swap: a human or another application changing the delegate between the final read and update can still lose that delegation change. The delegate-only write preserves concurrent description edits, but no global compare-and-set, external-writer exclusion or exactly-once guarantee is claimed. A confirmed handoff is not evidence that a model turn started.

## Native MCP setup

`createCyrusWorkerArtifacts({servers, headersHelperPath})` returns native HTTP MCP configuration, exact read/consult/report tool names and worker instructions. `servers` maps configured names to exact endpoints; the helper path is an absolute executable selected by the consumer.

`runCyrusHeadersHelper({servers, resolveCredential})` implements the native callback protocol. It validates SDK server-name and exact URL before credential lookup, emits only header JSON to stdout and uses fixed safe errors. The consumer's thin executable supplies its credential provider. Do not put a resolved bearer in MCP JSON or setup output.

Before work, the generated instructions require native Linear comment discovery even when the initial prompt has no commission ID. Cyrus 0.2.73 label-based intake omits comment threads; fallback intake can include only an initial page. The worker must discover the available native Linear tools and follow their actual result/pagination schema until the relevant comments are complete. The exact three commissioning grants do not provide native Linear access; retain that access in the consumer's existing reviewed native policy.

An ambiguous, inaccessible or unenrolled-server contract stops commissioned work. A missing contract also stops work when the prompt or retained handoff explicitly expects a commission. With no prior commissioning signal and no contract after discovery, ordinary work follows its existing instructions. A contract deleted before intake cannot be distinguished from never-commissioned work; missing-contract refusal is not universal. Consumers needing stricter isolation must supply an explicit dedicated commissioning context/policy.

The direct released runner accepts `ClaudeRunner({mcpConfigPath, allowedTools, systemPrompt})`. The portable runtime probe uses that public API. It is distinct from the daemon's configuration selection described below; a runner probe does not by itself qualify daemon routing.

### Cyrus daemon configuration

For released 0.2.73, root `linearMcpConfigs` supplies MCP files for Linear sessions using platform policy; root `githubMcpConfigs` does the corresponding job for GitHub/GitLab sessions. With a nonempty repository `allowedTools`, Cyrus selects that repository's `mcpConfigPath` instead. Keep existing paths when adding the generated file.

An existing explicitly scoped repository can include these fields:

```json
{
  "allowedTools": [
    "Read",
    "Glob",
    "Grep",
    "mcp__commissioner__commission_read",
    "mcp__commissioner__commission_consult",
    "mcp__commissioner__commission_report"
  ],
  "mcpConfigPath": ["/absolute/path/to/commissioning/mcp.json"],
  "appendInstruction": "Existing repository guidance followed by generated worker protocol contents."
}
```

This illustrates an existing read-only policy, **not a sufficient software-building policy** or a complete repository enrollment. Preserve your own reviewed complete list, denial rules, existing paths and other required fields. Do not replace an existing policy with this example.

`appendInstruction` is inline text, not a filename. Compose the generated file's contents with the existing value:

```ts
const protocol = await readFile("worker-instructions.md", "utf8");
candidateRepository.appendInstruction = [
  existingRepository.appendInstruction,
  protocol,
].filter(Boolean).join("\n\n");
```

The winning tool policy is repository label-prompt override, then global prompt-default override, repository explicit list, platform explicit list, then live native defaults. A winning list replaces lower-priority lists. There is no additive daemon field that extends inherited defaults with MCP tools. Where inheritance or a preset currently wins, the consumer must make an explicit policy decision; this connector does not silently copy native defaults into persistent overrides. Revisit that decision when changing Cyrus versions or policies.

Generated utilities do not rewrite vendor configuration, materialize defaults, place files or control services. They provide the native map, exact tool names and instructions for the appropriate supported setup surface.

The reference setup and portable conformance probe use actual packaged artifacts. Runner execution and pure daemon configuration resolution must be reported separately; neither establishes a live daemon's webhook intake. Keep native environment scrubbing enabled; the helper fetches through the consumer provider at invocation rather than relying on a bearer surviving a scrubbed worker environment. Its resolver receives cancellation; keep provider errors and secret contents out of logs.

## Feedback and stopped sessions

During active execution Cyrus reads work, consults, polls for the commissioner's durable answer and reports checkpoints/proposals. Revision decisions are discovered through subsequent MCP reads. Owner final prose/JSON is not a ledger decision.

If bounded polling remains pending, retain commission/question/proposal and branch/PR references in the worker's handoff. Once execution parks/exits, polling stops. Supported manual continuation is a human reply in its existing Cyrus Linear agent-session thread after the receiver is healthy. If restoration is impossible, use the supported fresh-session procedure on the same issue with those references. An app-authored issue comment is not a wake API. Automatic worker restart is not implemented or promised.

## Evidence boundaries

Synthetic external responses exercise the real connector's requests, reconciliation, preservation and privacy. A separate declared released-runner probe must load actual generated configuration/helper/instructions and call the real MCP endpoint with a loopback model. Its label and limited-comment fallback prompts come from public methods of the pinned release's published PromptBuilder file; that implementation-file dependency is test-only vendor conformance, not an application export. Both prompts start without the commission ID. A synthetic native Linear MCP peer supplies the actual connector-created comment through a declared paginated tool; the provider may derive commissioning call arguments only from the matching tool result. This qualifies the SDK/protocol wiring, not the hosted Linear tool schema, OAuth permissions or model judgment. It must not resolve a private preinstalled Cyrus tree.

Neither establishes production credentials, service identity, live Linear webhook intake, execution start or model judgment. Neutral-off qualification independently requires no Cyrus setup or external service call. See [validation](validation.md) for exact current evidence and missing qualifications.
