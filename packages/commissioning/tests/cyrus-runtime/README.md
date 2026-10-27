# Released Cyrus conformance probe

The manifest pins `cyrus-claude-runner`, `cyrus-core`, and `cyrus-edge-worker` to `0.2.73`. The probe
also requires the runner-resolved Claude Agent SDK to be exactly `0.3.281` and
fails if installed metadata differs. It never resolves an estate installation.

Prepare the public consumer using `tests/public-consumer.mjs`, then run
`tests/prepare-native.mjs <stage> --install-cyrus`. Installation and metadata
inspection do not start Cyrus or an Eve agent:

```sh
node tests/cyrus-runtime-proof.mjs --metadata <stage>
node tests/cyrus-runtime/config-resolution.mjs <stage>
node tests/cyrus-runtime/decoder-regression.mjs
```

The second command uses the released package's public `RunnerConfigBuilder`,
`ToolPermissionResolver`, and `McpConfigService` exports. It checks repository and
platform MCP path selection, explicit exact commissioning tool permissions,
policy precedence, and unchanged inherited configuration. It runs only the
canonical artifact generator and pure configuration methods. It starts no
helper, MCP server, daemon, agent, or model. The public builder accepts an already
assembled system prompt; preserving inline generated protocol at that boundary
does not qualify the full daemon's upstream prompt assembly.

The decoder regression uses the JSON envelope and exact trailing token-count
metadata observed from the declared SDK. It rejects unrelated tool calls and
targets, additional trailing payload and unrecorded answers. It starts no
runtime and does not require a staged consumer.

Runtime execution is a separate, explicit opt-in from installation and metadata
inspection. The existing native harness starts the installed example's Eve server,
then invokes the released runner:

```sh
COMMISSIONING_PROOF_ALLOW_RUNTIME=1 node tests/cyrus-runtime-proof.mjs <stage>
```

The probe consumes the installed example's canonical artifact generator and
headers helper. It asserts the generated instructions reach the model request,
the exact three commissioning tools are discovered alongside an explicitly declared synthetic native Linear comment tool. Actual released label and fallback prompts initially contain no commission ID (the fallback includes only fifty unrelated initial comments). The runner discovers the actual connector-created contract through that MCP tool, follows its declared pagination, and obtains commissioning call arguments only from the matching result. It then reads, consults, recovers an authored answer through its own read result, and reports a checkpoint. Missing-expected, ambiguous, inaccessible and unenrolled-server contracts leave the ledger unchanged; ordinary zero-contract intake remains ordinary and invokes no commissioning tool. The synthetic Linear peer does not qualify the hosted Linear tool schema or OAuth permissions.
Wrong credentials and a failing credential resolver must leave the commission
unchanged. A helper context mismatch must produce only the fixed sanitized error.
Every runner child uses an isolated home and the native subprocess scrub flag. The existing per-child turn/deadline and answer-poll limits are retained. No commission ID is injected into the label or limited-comment fallback prompt or supplied to tool calls through control-side state.

The model provider, work service, and credentials are synthetic. This does not
prove live Linear webhook intake, a paid model's behavior, worker wakeup, or
production execution start. The separate native workflow proof covers immutable
proposal revision and acceptance.
