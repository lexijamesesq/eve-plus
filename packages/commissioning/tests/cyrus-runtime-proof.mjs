import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const thisFile = fileURLToPath(import.meta.url);
const expectedVersions = { runner: "0.2.73", core: "0.2.73", sdk: "0.3.281" };
const toolNames = ["commission_consult", "commission_read", "commission_report"];
const runtimeAllowed = () =>
  assert.equal(
    process.env.COMMISSIONING_PROOF_ALLOW_RUNTIME,
    "1",
    "Cyrus runtime execution is held until explicitly authorized after Gate B",
  );
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

async function packageMetadata(requireFrom, name) {
  let root = dirname(requireFrom.resolve(name));
  for (;;) {
    const metadata = await readJson(join(root, "package.json")).catch(() => null);
    if (metadata?.name === name) return { root, ...metadata };
    const parent = dirname(root);
    assert.notEqual(parent, root, `Installed metadata unavailable: ${name}`);
    root = parent;
  }
}

/** Metadata inspection imports no runner and starts no process or service. */
export async function inspectCyrusRuntime(stage) {
  const requireRuntime = createRequire(join(resolve(stage), "cyrus-runtime/package.json"));
  const runner = await packageMetadata(requireRuntime, "cyrus-claude-runner");
  const core = await packageMetadata(requireRuntime, "cyrus-core");
  const requireRunner = createRequire(join(runner.root, "package.json"));
  const sdk = await packageMetadata(requireRunner, "@anthropic-ai/claude-agent-sdk");
  const versions = { runner: runner.version, core: core.version, sdk: sdk.version };
  assert.deepEqual(versions, expectedVersions, "Released runtime must match the qualified target");
  return versions;
}

async function child(command, args, options, timeoutMs = 60000) {
  const subprocess = spawn(command, args, {
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const buffers = { stdout: [], stderr: [] };
  for (const stream of ["stdout", "stderr"])
    subprocess[stream].on("data", (chunk) => {
      if (buffers[stream].reduce((size, part) => size + part.length, 0) < 1_048_576)
        buffers[stream].push(chunk);
    });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      process.kill(-subprocess.pid, "SIGTERM");
    } catch {}
    setTimeout(() => {
      try {
        process.kill(-subprocess.pid, "SIGKILL");
      } catch {}
    }, 1000).unref();
  }, timeoutMs);
  try {
    const [code, signal] = await once(subprocess, "exit");
    return {
      code,
      signal,
      timedOut,
      stdout: Buffer.concat(buffers.stdout).toString(),
      stderr: Buffer.concat(buffers.stderr).toString(),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function sdkResultObjects(value, match, depth = 0) {
  if (depth > 8) return [];
  if (typeof value === "string") {
    try {
      // SDK 0.3.281 appends this observed token-count metadata after tool-result JSON.
      // Strip only that complete trailing envelope; arbitrary suffixes remain invalid JSON.
      const json = value.replace(
        /\n\n<system-reminder>\n<total_tokens>\d+ tokens left<\/total_tokens>\n<\/system-reminder>(?![\s\S])/,
        "",
      );
      return sdkResultObjects(JSON.parse(json), match, depth + 1);
    } catch {
      return [];
    }
  }
  if (Array.isArray(value))
    return value.flatMap((item) => sdkResultObjects(item, match, depth + 1));
  if (!value || typeof value !== "object") return [];
  if (match(value)) return [value];
  return Object.values(value).flatMap((item) => sdkResultObjects(item, match, depth + 1));
}

function commissionResults(value) {
  return sdkResultObjects(
    value,
    (item) => typeof item.commissionId === "string" && Array.isArray(item.questions),
  );
}

/** Test provider dataflow: IDs come only from the actual matched Linear MCP result. */
export function discoverCommentContract(
  messages,
  { issueId, issueUrl, serverName, endpoint, expected },
) {
  const blocks = messages.flatMap((message) =>
    Array.isArray(message.content) ? message.content : [],
  );
  const calls = blocks.filter(
    (block) =>
      block.type === "tool_use" &&
      block.name === "mcp__linear__list_comments" &&
      block.input?.issueId === issueId,
  );
  const comments = [];
  let cursor;
  const visited = new Set();
  for (;;) {
    if (visited.has(cursor)) return { status: "refuse", reason: "invalid_pagination" };
    visited.add(cursor);
    const call = calls.find((item) => item.input.cursor === cursor);
    if (!call) return { status: "pending", cursor };
    const result = blocks.find(
      (block) => block.type === "tool_result" && block.tool_use_id === call.id,
    );
    if (!result) return { status: "pending", cursor };
    if (result.is_error) return { status: "refuse", reason: "comment_discovery_failed" };
    const pages = sdkResultObjects(
      result.content,
      (item) => Array.isArray(item.comments) && Object.hasOwn(item, "nextCursor"),
    );
    if (
      pages.length !== 1 ||
      pages[0].comments.some((item) => item.issueId !== issueId || typeof item.body !== "string")
    )
      return { status: "refuse", reason: "invalid_comment_result" };
    comments.push(...pages[0].comments);
    if (pages[0].nextCursor === null) break;
    if (typeof pages[0].nextCursor !== "string" || !pages[0].nextCursor)
      return { status: "refuse", reason: "invalid_pagination" };
    cursor = pages[0].nextCursor;
  }
  const contracts = comments.filter((comment) => comment.body.includes("<!-- eve-commission:"));
  if (!contracts.length)
    return expected
      ? { status: "refuse", reason: "missing_expected_contract" }
      : { status: "ordinary" };
  if (contracts.length !== 1) return { status: "refuse", reason: "ambiguous_contract" };
  const body = contracts[0].body;
  const header =
    /^<!-- eve-commission:([^\s]+) -->\n## Commissioning contract\nCommission ID: ([^\s]+)\nMCP server: ([A-Za-z0-9_-]+)\nEndpoint: ([^\s]+)\nCanonical work issue: ([^\s]+)\n/.exec(
      body,
    );
  if (
    !header ||
    header[1] !== header[2] ||
    !body.endsWith(`<!-- /eve-commission:${header[1]} -->`) ||
    header[5] !== issueUrl
  )
    return { status: "refuse", reason: "invalid_contract" };
  if (header[3] !== serverName || header[4] !== endpoint)
    return { status: "refuse", reason: "unenrolled_server" };
  return { status: "linked", commissionId: header[1] };
}

/** Version-pinned vendor conformance only; applications do not import this implementation file. */
export async function buildNativeIntakePrompts(stage, { issue, initialComments }) {
  const requireRuntime = createRequire(join(resolve(stage), "cyrus-runtime/package.json"));
  const edge = await packageMetadata(requireRuntime, "cyrus-edge-worker");
  assert.equal(edge.version, "0.2.73");
  // Published subpath, public class methods, no private-method invocation or vendor modification.
  const { PromptBuilder } = await import(
    pathToFileURL(requireRuntime.resolve("cyrus-edge-worker/dist/PromptBuilder.js")).href
  );
  assert.equal(typeof PromptBuilder, "function", "Pinned published prompt-builder layout changed");
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const repository = {
    id: "synthetic",
    name: "synthetic",
    baseBranch: "main",
    repositoryPath: "/synthetic/repository",
    linearWorkspaceId: "synthetic-workspace",
  };
  const tracker = {
    fetchTeams: async () => ({ nodes: [] }),
    fetchLabels: async () => ({ nodes: [] }),
    fetchComments: async () => ({
      nodes: initialComments.map((comment) => ({
        ...comment,
        parent: Promise.resolve(null),
        user: Promise.resolve({ name: "Synthetic author" }),
        createdAt: new Date("2026-01-01T00:00:00Z"),
      })),
    }),
  };
  const builder = new PromptBuilder({
    logger,
    repositories: new Map([[repository.id, repository]]),
    issueTrackers: new Map([[repository.linearWorkspaceId, tracker]]),
    gitService: { sanitizeBranchName: (value) => value },
  });
  const input = {
    ...issue,
    identifier: "ENG-123",
    title: "Synthetic commissioning work",
    branchName: "eng-123-fixture",
    priority: 0,
    state: Promise.resolve({ name: "Planning" }),
  };
  const branches = { synthetic: { branch: "main" } };
  const label = await builder.buildLabelBasedPrompt(input, [repository], "", undefined, branches);
  const fallback = await builder.buildIssueContextPrompt(
    input,
    [repository],
    undefined,
    "",
    undefined,
    branches,
  );
  assert.ok(label.prompt && fallback.prompt);
  return { label: label.prompt, fallback: fallback.prompt };
}

/** The synthetic provider accepts answers only from its actual, matching SDK read call results. */
export function hasRecoveredCommissionerAnswer(
  messages,
  commissionId,
  questionId = "released-runner-question",
) {
  const blocks = messages.flatMap((message) =>
    Array.isArray(message.content) ? message.content : [],
  );
  const readIds = new Set(
    blocks
      .filter(
        (block) =>
          block.type === "tool_use" &&
          block.name === "mcp__commissioner__commission_read" &&
          block.input?.commissionId === commissionId,
      )
      .map((block) => block.id),
  );
  const views = blocks
    .filter((block) => block.type === "tool_result" && readIds.has(block.tool_use_id))
    .flatMap((block) => commissionResults(block.content));
  return views.some(
    (view) =>
      view.commissionId === commissionId &&
      view.questions.some(
        (question) =>
          question.questionId === questionId &&
          question.status === "answered" &&
          question.answer?.answer === "Use the recorded acceptance criteria",
      ),
  );
}

function systemText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(systemText).join("\n");
  return value?.text ?? "";
}

function providerResponse(response, body, block, sequence) {
  const reason = block.type === "tool_use" ? "tool_use" : "end_turn";
  const message = {
    id: `msg_probe_${sequence}`,
    type: "message",
    role: "assistant",
    model: body.model,
    content: [block],
    stop_reason: reason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  };
  if (!body.stream) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(message));
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  const send = (event, data) =>
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("message_start", {
    type: "message_start",
    message: {
      ...message,
      content: [],
      stop_reason: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  });
  send("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: block.type === "tool_use" ? { ...block, input: {} } : { type: "text", text: "" },
  });
  send("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta:
      block.type === "tool_use"
        ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
        : { type: "text_delta", text: block.text },
  });
  send("content_block_stop", { type: "content_block_stop", index: 0 });
  send("message_delta", {
    type: "message_delta",
    delta: { stop_reason: reason, stop_sequence: null },
    usage: { output_tokens: 10 },
  });
  send("message_stop", { type: "message_stop" });
  response.end();
}

// The released runner lives in an isolated child with an explicit, scrubbed environment.
async function runnerChild(stage, caseRoot) {
  runtimeAllowed();
  assert.equal(process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, "1");
  const requireRuntime = createRequire(join(stage, "cyrus-runtime/package.json"));
  const load = (name) => import(pathToFileURL(requireRuntime.resolve(name)).href);
  const { ClaudeRunner } = await load("cyrus-claude-runner");
  const { LogLevel } = await load("cyrus-core");
  const settings = await readJson(join(caseRoot, "runner-settings.json"));
  const logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    event() {},
    getLevel: () => LogLevel.INFO,
    withContext() {
      return this;
    },
  };
  let completed = false;
  let runnerError = false;
  const runner = new ClaudeRunner({
    cyrusHome: join(caseRoot, "cyrus"),
    workingDirectory: join(caseRoot, "work"),
    mcpConfigPath: settings.mcpConfigPath,
    model: "claude-sonnet-4-5",
    maxTurns: 12,
    tools: [],
    allowedTools: settings.allowedTools,
    logger,
    systemPrompt: settings.instructions,
    additionalEnv: {
      ANTHROPIC_BASE_URL: process.env.PROBE_PROVIDER_URL,
      ANTHROPIC_API_KEY: "synthetic-only",
      CLAUDE_CONFIG_DIR: join(caseRoot, "claude"),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      MCP_CONNECTION_NONBLOCKING: "false",
      ENABLE_TOOL_SEARCH: "false",
    },
    onMessage(message) {
      if (message.type === "result") completed = !message.is_error;
    },
    onError() {},
  });
  process.on("SIGTERM", () => {
    runner.stop();
    setTimeout(() => process.exit(143), 500).unref();
  });
  try {
    await runner.start(settings.prompt);
  } catch {
    runnerError = true;
  }
  await writeFile(
    join(caseRoot, "runner-result.json"),
    JSON.stringify({
      completed,
      runnerError,
      subprocessEnvironmentScrub: process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB === "1",
    }),
  );
}

/** Consumes the actual native Eve endpoint started by native-proof.mjs. It never substitutes an MCP handler. */
export async function runCyrusProbe(
  stage,
  { endpoint, commissionId, dataDir, issue, contractComments },
) {
  runtimeAllowed();
  stage = resolve(stage);
  const versions = await inspectCyrusRuntime(stage);
  const consumer = join(stage, "consumer");
  const requireConsumer = createRequire(join(consumer, "package.json"));
  const load = (name) => import(pathToFileURL(requireConsumer.resolve(name)).href);
  const { Client } = await load("@modelcontextprotocol/sdk/client/index.js");
  const { McpServer } = await load("@modelcontextprotocol/sdk/server/mcp.js");
  const { WebStandardStreamableHTTPServerTransport } = await load(
    "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js",
  );
  const { z } = await load("zod");
  const { StreamableHTTPClientTransport } = await load(
    "@modelcontextprotocol/sdk/client/streamableHttp.js",
  );
  const config = await readJson(join(stage, "native-config.json"));
  assert.equal(endpoint, config.EXAMPLE_MCP_ENDPOINT);
  assert.equal(
    new URL(endpoint).hostname,
    "127.0.0.1",
    "Probe connects only to the synthetic loopback endpoint",
  );
  const signed = config.EXAMPLE_WORKER_AUTH === "signed";
  const commissioningRoot = dirname(dirname(requireConsumer.resolve("@eve-plus/commissioning")));
  const commissioningManifest = await readJson(join(commissioningRoot, "package.json"));
  const signedControl = signed
    ? (
        await import(
          pathToFileURL(join(commissioningRoot, commissioningManifest.exports["./auth"].import))
            .href
        )
      ).createSignedWorkerCredential({
        issuer: "urn:example:commissioning:worker",
        subject: "example:builder",
        resolvePrivateKey: () => readFile(join(stage, "synthetic-worker-private.pem"), "utf8"),
      })
    : undefined;
  const controlBearer = signedControl
    ? await signedControl({ endpoint, signal: new AbortController().signal })
    : config.EXAMPLE_WORKER_TOKEN;
  const root = join(dirname(dataDir), "cyrus-runtime");
  await mkdir(root, { recursive: true });
  const connect = async () => {
    const client = new Client({ name: "released-cyrus-probe-control", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(endpoint), {
        requestInit: { headers: { authorization: `Bearer ${controlBearer}` } },
      }),
    );
    return client;
  };
  const control = await connect();
  const read = async () => {
    const result = await control.callTool({ name: "commission_read", arguments: { commissionId } });
    assert.notEqual(result.isError, true, "Real MCP read failed");
    return result.structuredContent.result;
  };
  assert.equal(
    contractComments.length,
    1,
    "Probe must receive the actual connector-created contract",
  );
  const initialComments = Array.from({ length: 50 }, (_value, index) => ({
    id: `initial-${index}`,
    body: `Initial unrelated comment ${index}`,
    issueId: issue.id,
  }));
  const prompts = await buildNativeIntakePrompts(stage, { issue, initialComments });
  assert.equal(
    prompts.label.includes(commissionId),
    false,
    "Label intake must discover its ID, not receive it in the prompt",
  );
  assert.equal(
    prompts.fallback.includes(commissionId),
    false,
    "Limited fallback page must not smuggle the commission ID",
  );
  assert.ok(prompts.fallback.includes("Initial unrelated comment"));
  const cases = [];
  let active;
  let sequence = 0;
  const linearPeer = createServer(async (request, response) => {
    const server = new McpServer({ name: "synthetic-native-linear", version: "1" });
    server.registerTool(
      "list_comments",
      {
        description:
          "List comments for this issue, following the declared cursor until nextCursor is null.",
        inputSchema: { issueId: z.string(), cursor: z.string().optional() },
      },
      async (input) => {
        assert.equal(input.issueId, issue.id);
        active.commentToolRequests++;
        if (active.mode === "comment-failure")
          return {
            isError: true,
            content: [{ type: "text", text: "Synthetic comments unavailable" }],
          };
        let comments;
        let nextCursor = null;
        if (["missing-expected", "ordinary"].includes(active.mode)) comments = [];
        else if (!input.cursor) {
          comments = initialComments;
          nextCursor = "commissioning-contract-page";
        } else {
          assert.equal(input.cursor, "commissioning-contract-page");
          comments = contractComments.map((comment) => ({ ...comment, issueId: issue.id }));
          if (active.mode === "ambiguous")
            comments.push({
              ...comments[0],
              id: "foreign-comment",
              body: comments[0].body.replaceAll(commissionId, "foreign-commission"),
            });
          if (active.mode === "wrong-server")
            comments = comments.map((comment) => ({
              ...comment,
              body: comment.body.replace("MCP server: commissioner", "MCP server: unenrolled"),
            }));
        }
        const body = { comments, nextCursor };
        return { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body };
      },
    );
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const result = await transport.handleRequest(
        new Request(`http://127.0.0.1${request.url}`, {
          method: request.method,
          headers: request.headers,
          body: request.method === "POST" ? Buffer.concat(chunks) : undefined,
        }),
      );
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch {
      response.writeHead(500);
      response.end("Synthetic Linear peer failed");
    } finally {
      await server.close();
    }
  });
  const provider = createServer(async (request, response) => {
    let providerCheck = "request_decode";
    try {
      if (!request.url.startsWith("/v1/messages")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"data":[],"has_more":false}');
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      active.modelRequests++;
      // Private synthetic payloads support diagnosis; reports contain only the projection below.
      await writeFile(
        join(active.caseRoot, `provider-request-${active.modelRequests}.json`),
        JSON.stringify(body),
        { mode: 0o600 },
      );
      const diagnosticBlocks = (body.messages ?? []).flatMap((message) =>
        Array.isArray(message.content) ? message.content : [],
      );
      const diagnosticReadIds = new Set(
        diagnosticBlocks
          .filter((block) => block.type === "tool_use" && block.name.endsWith("__commission_read"))
          .map((block) => block.id),
      );
      const diagnosticResults = diagnosticBlocks.filter(
        (block) => block.type === "tool_result" && diagnosticReadIds.has(block.tool_use_id),
      );
      const diagnosticViews = diagnosticResults.flatMap((block) =>
        commissionResults(block.content),
      );
      active.requestSummaries.push({
        request: active.modelRequests,
        timestamp: new Date().toISOString(),
        path: new URL(request.url, "http://127.0.0.1").pathname,
        readToolIds: [...diagnosticReadIds],
        matchingReadResults: diagnosticResults.length,
        resultContentShapes: [
          ...new Set(
            diagnosticResults.map((block) =>
              Array.isArray(block.content) ? "array" : typeof block.content,
            ),
          ),
        ],
        parsedReadViews: diagnosticViews.length,
        matchingCommissionViews: diagnosticViews.filter(
          (view) => view.commissionId === commissionId,
        ).length,
        targetQuestionPresent: diagnosticViews.some((view) =>
          view.questions.some((question) => question.questionId === active.questionId),
        ),
        canonicalAnswerSeen: diagnosticViews.some(
          (view) =>
            view.commissionId === commissionId &&
            view.questions.some(
              (question) =>
                question.questionId === active.questionId &&
                question.status === "answered" &&
                question.answer?.answer === "Use the recorded acceptance criteria",
            ),
        ),
      });
      providerCheck = "generated_instructions_missing";
      assert.ok(
        systemText(body.system).includes(active.instructions),
        "Packaged generated instructions were not loaded by the runner",
      );
      const available = (body.tools ?? []).map((tool) => tool.name).sort();
      providerCheck = "unexpected_tool_permission";
      for (const name of available)
        assert.ok(active.allowedTools.includes(name), "Unexpected runner tool permission");
      providerCheck = "tool_inventory_mismatch";
      if (active.mode.startsWith("valid"))
        assert.deepEqual(available, active.allowedTools.slice().sort());
      const blocks = (body.messages ?? []).flatMap((message) =>
        Array.isArray(message.content) ? message.content : [],
      );
      const results = blocks.filter((block) => block.type === "tool_result");
      const called = blocks.filter((block) => block.type === "tool_use");
      providerCheck = "worker_tool_failed";
      const workerIds = new Set(
        called
          .filter((block) => block.name.startsWith("mcp__commissioner__"))
          .map((block) => block.id),
      );
      const expectedRefreshFailure =
        signed && active.mode === "jwt-refresh-failure"
          ? called.find(
              (block) =>
                block.name === "mcp__commissioner__commission_consult" &&
                block.input?.commissionId === commissionId &&
                block.input?.questionId === active.questionId,
            )
          : undefined;
      assert.equal(
        results.some(
          (block) =>
            workerIds.has(block.tool_use_id) &&
            block.is_error &&
            block.tool_use_id !== expectedRefreshFailure?.id,
        ),
        false,
        "Real commissioning tool failed",
      );
      const discovered = discoverCommentContract(body.messages ?? [], {
        issueId: issue.id,
        issueUrl: issue.url,
        serverName: "commissioner",
        endpoint,
        expected: systemText(body.messages?.[0]?.content).includes("Commissioned work is expected"),
      });
      let action;
      if (discovered.status === "pending")
        action = {
          name: "mcp__linear__list_comments",
          input: { issueId: issue.id, ...(discovered.cursor ? { cursor: discovered.cursor } : {}) },
        };
      else if (discovered.status === "refuse" || discovered.status === "ordinary")
        active.disposition = discovered;
      else {
        active.discoveredCommissionId = discovered.commissionId;
        // No control-side commission ID enters tool arguments: it came from the matched Linear result.
        const linkedId = discovered.commissionId;
        if (!called.some((block) => block.name === "mcp__commissioner__commission_read"))
          action = {
            name: "mcp__commissioner__commission_read",
            input: { commissionId: linkedId },
          };
        else if (!called.some((block) => block.name === "mcp__commissioner__commission_consult")) {
          if (signed && !active.expiryBoundary) {
            assert.ok(
              commissionResults(body.messages).some((view) => view.commissionId === linkedId),
              "Signed runner must first complete a real authorized read",
            );
            const authJournal = (await readFile(config.FIXTURE_WORKER_AUTH_JOURNAL, "utf8"))
              .trim()
              .split("\n")
              .filter(Boolean)
              .map(JSON.parse);
            const firstRead = authJournal.findLast(
              (entry) => entry.accepted && entry.tool === "commission_read",
            );
            assert.ok(firstRead?.expiresAt);
            active.firstIssuedAt = firstRead.issuedAt;
            active.expiryBoundary = firstRead.expiresAt * 1000 + 30_000;
            if (active.mode === "jwt-refresh-failure")
              await rm(join(active.caseRoot, "signing-key.pem"));
            // Genuine expiry under the production verifier's 30-second tolerance; no injected401 or clock.
            await new Promise((resolve) =>
              setTimeout(resolve, Math.max(0, active.expiryBoundary + 200 - Date.now())),
            );
          }
          action = {
            name: "mcp__commissioner__commission_consult",
            input: {
              commissionId: linkedId,
              questionId: active.questionId,
              question: { text: "Which behavior meets the recorded acceptance criteria?" },
            },
          };
        } else if (signed) {
          const consult = called.find(
            (block) =>
              block.name === "mcp__commissioner__commission_consult" &&
              block.input?.commissionId === linkedId &&
              block.input?.questionId === active.questionId,
          );
          assert.ok(consult, "Signed proof requires its matching consult call");
          const result = results.find((block) => block.tool_use_id === consult.id);
          assert.ok(result, "Signed proof requires its correlated consult result");
          if (active.mode === "jwt-refresh-failure") {
            active.refreshRejected = result.is_error === true;
            assert.equal(
              active.refreshRejected,
              true,
              "Failed signing custody must reject the tool",
            );
          } else {
            assert.notEqual(result.is_error, true, "Refreshed consult must succeed");
            active.consultAccepted =
              sdkResultObjects(
                result.content,
                (value) => value.recorded === true && value.result?.commissionId === linkedId,
              ).length > 0;
            assert.equal(
              active.consultAccepted,
              true,
              "Refreshed consult must return a valid recorded response",
            );
          }
        } else {
          active.answerRecovered = hasRecoveredCommissionerAnswer(
            body.messages ?? [],
            linkedId,
            active.questionId,
          );
          const reads = called.filter(
            (block) => block.name === "mcp__commissioner__commission_read",
          ).length;
          if (!active.answerRecovered || reads < 2) {
            providerCheck = "answer_poll_exhausted";
            assert.ok(reads < 8, "Bounded answer polling exhausted");
            action = {
              name: "mcp__commissioner__commission_read",
              input: { commissionId: linkedId },
            };
          } else if (!called.some((block) => block.name === "mcp__commissioner__commission_report"))
            action = {
              name: "mcp__commissioner__commission_report",
              input: {
                commissionId: linkedId,
                eventId: "released-runner-checkpoint",
                kind: "checkpoint",
                data: { summary: "Recovered the explicit commissioner answer through MCP" },
              },
            };
        }
      }
      const name = action?.name;
      if (name && available.includes(name)) {
        if (name.startsWith("mcp__commissioner__"))
          active.requestedTools.push(name.slice("mcp__commissioner__".length));
        else active.requestedLinearTools.push(name);
        providerResponse(
          response,
          body,
          { type: "tool_use", id: `probe_${++sequence}`, name, input: action.input },
          sequence,
        );
      } else
        providerResponse(
          response,
          body,
          { type: "text", text: "Synthetic probe complete." },
          ++sequence,
        );
    } catch {
      active.providerFailure = true;
      active.providerFailureClass = providerCheck;
      response.writeHead(500, { "content-type": "application/json" });
      response.end('{"error":{"type":"api_error","message":"Synthetic probe failed"}}');
    }
  });
  try {
    assert.deepEqual((await control.listTools()).tools.map((tool) => tool.name).sort(), toolNames);
    await read();
    linearPeer.listen(0, "127.0.0.1");
    await once(linearPeer, "listening");
    const linearPeerUrl = `http://127.0.0.1:${linearPeer.address().port}/mcp`;
    provider.listen(0, "127.0.0.1");
    await once(provider, "listening");
    const providerUrl = `http://127.0.0.1:${provider.address().port}`;
    for (const mode of signed
      ? ["valid-jwt-expiry", "jwt-refresh-failure"]
      : [
          "valid-label",
          "valid-fallback",
          "missing-expected",
          "ambiguous",
          "wrong-server",
          "ordinary",
          "comment-failure",
          "wrong-credential",
          "helper-failure",
        ]) {
      const caseRoot = join(root, mode);
      await mkdir(join(caseRoot, "work"), { recursive: true });
      const tokenPath = join(caseRoot, "worker-token");
      if (mode !== "helper-failure")
        await writeFile(
          tokenPath,
          mode === "wrong-credential" ? "incorrect-synthetic-only" : config.EXAMPLE_WORKER_TOKEN,
          { mode: 0o600 },
        );
      if (signed) {
        await writeFile(
          join(caseRoot, "signing-key.pem"),
          await readFile(join(stage, "synthetic-worker-private.pem")),
          { mode: 0o600 },
        );
      }
      const env = {
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: caseRoot,
        TMPDIR: caseRoot,
        EXAMPLE_MCP_ENDPOINT: endpoint,
        EXAMPLE_WORKER_CREDENTIAL_FILE: tokenPath,
        ...(signed
          ? {
              EXAMPLE_WORKER_AUTH: "signed",
              EXAMPLE_WORKER_ISSUER: config.EXAMPLE_WORKER_ISSUER,
              EXAMPLE_WORKER_PRIVATE_KEY_FILE: join(caseRoot, "signing-key.pem"),
            }
          : {}),
      };
      const generated = await child(
        process.execPath,
        [join(consumer, "scripts/worker-artifacts.mjs")],
        { cwd: consumer, env },
      );
      assert.equal(generated.code, 0, "Canonical artifact generation failed");
      const mcp = await readJson(join(consumer, "mcp.json"));
      if (signed) {
        const settingsPath = join(consumer, "scripts/worker-settings.json");
        const settings = await readJson(settingsPath);
        // Ordinary public signer configuration, shortened only in this isolated fixture.
        settings.signedCredential.lifetimeSeconds = 2;
        await writeFile(settingsPath, JSON.stringify(settings));
      }
      const commissionAllowedTools = await readJson(join(consumer, "worker-allowed-tools.json"));
      const allowedTools = [...commissionAllowedTools, "mcp__linear__list_comments"];
      const instructions = await readFile(join(consumer, "worker-instructions.md"), "utf8");
      assert.deepEqual(
        commissionAllowedTools.slice().sort(),
        toolNames.map((tool) => `mcp__commissioner__${tool}`).sort(),
      );
      assert.equal(
        mcp.mcpServers.commissioner.headersHelper,
        join(consumer, "scripts/headers-helper.mjs"),
      );
      assert.equal(JSON.stringify(mcp).includes(config.EXAMPLE_WORKER_TOKEN), false);
      assert.ok(instructions.includes("Only the commissioner records acceptance"));
      assert.ok(instructions.includes("does not automatically resume"));
      const helperControl = await child(
        process.execPath,
        [mcp.mcpServers.commissioner.headersHelper],
        {
          cwd: consumer,
          env: {
            ...env,
            CLAUDE_CODE_MCP_SERVER_NAME: "wrong-server",
            CLAUDE_CODE_MCP_SERVER_URL: endpoint,
          },
        },
      );
      assert.equal(helperControl.code, 1);
      assert.equal(helperControl.stdout, "");
      assert.equal(helperControl.stderr, "Commissioning authentication unavailable\n");
      const linearMcpPath = join(caseRoot, "synthetic-linear-mcp.json");
      await writeFile(
        linearMcpPath,
        JSON.stringify({ mcpServers: { linear: { type: "http", url: linearPeerUrl } } }),
      );
      const prompt = `${mode === "valid-fallback" ? prompts.fallback : prompts.label}\n\n${mode === "missing-expected" ? "Commissioned work is expected for this issue; stop if its contract is missing." : "Follow the commissioning discovery protocol before work."}\n${signed ? "For this synthetic authentication qualification, complete a read and bounded consult, then report its result and finish. This case does not qualify the answer/checkpoint loop." : "For this synthetic qualification, ask a bounded question, recover its explicit answer and report a checkpoint when a linked contract exists."}`;
      await writeFile(
        join(caseRoot, "runner-settings.json"),
        JSON.stringify({
          prompt,
          mcpConfigPath: [join(consumer, "mcp.json"), linearMcpPath],
          allowedTools,
          instructions,
        }),
      );
      active = {
        caseRoot,
        mode,
        questionId: signed ? `released-runner-${mode}` : "released-runner-question",
        allowedTools,
        instructions,
        modelRequests: 0,
        requestedTools: [],
        requestedLinearTools: [],
        commentToolRequests: 0,
        discoveredCommissionId: null,
        disposition: null,
        answerRecovered: false,
        consultAccepted: false,
        providerFailure: false,
        providerFailureClass: null,
        requestSummaries: [],
      };
      const authBefore = signed
        ? (await readFile(config.FIXTURE_WORKER_AUTH_JOURNAL, "utf8"))
            .trim()
            .split("\n")
            .filter(Boolean).length
        : 0;
      const before = await read();
      const result = await child(process.execPath, [thisFile, "--runner-child", stage, caseRoot], {
        cwd: caseRoot,
        env: {
          PATH: env.PATH,
          HOME: caseRoot,
          TMPDIR: caseRoot,
          COMMISSIONING_PROOF_ALLOW_RUNTIME: "1",
          PROBE_PROVIDER_URL: providerUrl,
          CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
        },
      });
      const runner = await readJson(join(caseRoot, "runner-result.json")).catch(() => null);
      await writeFile(
        join(caseRoot, "case-observations.json"),
        `${JSON.stringify(
          {
            mode,
            versions,
            node: process.version,
            exitCode: result.code,
            timedOut: result.timedOut,
            runner,
            modelRequests: active.modelRequests,
            requestedTools: active.requestedTools,
            requestedLinearTools: active.requestedLinearTools,
            commentToolRequests: active.commentToolRequests,
            discoveredCommissionId: active.discoveredCommissionId,
            disposition: active.disposition,
            initialPromptContainsCommissionId: prompt.includes(commissionId),
            answerRecovered: active.answerRecovered,
            providerFailureClass: active.providerFailureClass,
            requestSummaries: active.requestSummaries,
          },
          null,
          2,
        )}\n`,
      );
      assert.equal(result.timedOut, false, "Released runner exceeded its synthetic bound");
      assert.equal(result.code, 0, "Released runner child failed");
      assert.ok(runner, "Released runner receipt unavailable");
      assert.equal(runner.subprocessEnvironmentScrub, true);
      const after = await read();
      if (signed) {
        assert.equal(active.providerFailure, false);
        assert.equal(runner.completed, true);
        assert.equal(runner.runnerError, false);
        const authJournal = (await readFile(config.FIXTURE_WORKER_AUTH_JOURNAL, "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map(JSON.parse)
          .slice(authBefore);
        const consultAttempts = authJournal.filter(
          (entry) =>
            entry.tool === "commission_consult" &&
            entry.arguments?.questionId === active.questionId,
        );
        assert.ok(
          consultAttempts.some(
            (entry) => !entry.accepted && entry.time > entry.expiresAt * 1000 + 30_000,
          ),
          "Actual expired bearer must be refused by the real native verifier",
        );
        assert.ok(
          consultAttempts.length <= 2,
          "Native authentication recovery retries at most once",
        );
        for (const attempt of consultAttempts)
          assert.deepEqual(
            attempt.arguments,
            consultAttempts[0].arguments,
            "Authentication retry preserves the logical operation",
          );
        if (mode === "valid-jwt-expiry") {
          assert.ok(
            consultAttempts.some(
              (entry) => entry.accepted && entry.issuedAt > active.firstIssuedAt,
            ),
            "Refreshed helper token must succeed with a fresh issuance",
          );
          assert.equal(
            after.questions.filter((question) => question.questionId === active.questionId).length,
            1,
          );
        } else {
          assert.ok(consultAttempts.every((entry) => !entry.accepted));
          assert.equal(active.refreshRejected, true);
          assert.equal(
            after.nextCursor,
            before.nextCursor,
            "Failed refresh must not mutate the ledger",
          );
        }
        await writeFile(
          join(caseRoot, "auth-observations.json"),
          JSON.stringify(
            {
              expiryBoundary: active.expiryBoundary,
              firstIssuedAt: active.firstIssuedAt,
              consultAttempts,
            },
            null,
            2,
          ),
        );
      }
      if (mode.startsWith("valid")) {
        assert.equal(active.discoveredCommissionId, commissionId);
        assert.equal(active.commentToolRequests, 2);
        assert.equal(prompt.includes(commissionId), false);
        assert.equal(active.providerFailure, false);
        assert.ok(active.modelRequests > 0);
        assert.equal(runner.completed, true);
        assert.equal(runner.runnerError, false);
        if (signed) assert.equal(active.consultAccepted, true);
        else {
          assert.equal(active.answerRecovered, true);
          assert.ok(active.requestedTools.filter((name) => name === "commission_read").length >= 2);
          assert.ok(
            after.events.some(
              (event) =>
                event.eventId === "event:released-runner-checkpoint" && event.kind === "checkpoint",
            ),
          );
        }
      } else if (mode !== "jwt-refresh-failure") {
        assert.equal(active.providerFailure, false);
        if (mode === "ordinary") assert.deepEqual(active.disposition, { status: "ordinary" });
        else if (!["wrong-credential", "helper-failure"].includes(mode))
          assert.equal(active.disposition?.status, "refuse");
        assert.equal(
          active.requestedTools.length,
          0,
          "Refused, ordinary, or unauthenticated intake invoked commissioning tools",
        );
        assert.equal(after.nextCursor, before.nextCursor, "Failed helper changed the commission");
      }
      cases.push({
        mode,
        passed: true,
        modelRequests: active.modelRequests,
        requestedTools: active.requestedTools,
        requestedLinearTools: active.requestedLinearTools,
        commentToolRequests: active.commentToolRequests,
        contractDiscoveredFromActualToolResult: active.discoveredCommissionId === commissionId,
        disposition: active.disposition,
        initialPromptContainsCommissionId: prompt.includes(commissionId),
        answerRecovered: active.answerRecovered,
        authenticationOnly: signed,
        consultAccepted: active.consultAccepted,
        exactThreeToolPolicy: true,
        wrongHelperContextRejected: true,
        subprocessEnvironmentScrub: true,
        canonicalHelperAndGeneratedInstructions: true,
      });
    }
    const receipt = {
      case: "released-cyrus-native-mcp",
      passed: true,
      versions,
      cases,
      actualPinnedLabelAndFallbackPromptBuilder: true,
      nativeLinearPeer:
        "Synthetic declared MCP tools, not hosted Linear schema or production OAuth qualification",
      executionPending: false,
      limits:
        "Released runner and SDK; real installed Eve MCP endpoint; synthetic credentials and loopback model only. Signed cases qualify authentication expiry/refresh only, not the full answer/checkpoint loop. No live Cyrus webhook, paid model, external work message, automatic wake, or production execution-start claim.",
    };
    await writeFile(join(root, "result.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    return receipt;
  } finally {
    await control.close();
    linearPeer.closeAllConnections();
    if (linearPeer.listening) await new Promise((done) => linearPeer.close(done));
    provider.closeAllConnections();
    if (provider.listening) await new Promise((done) => provider.close(done));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === thisFile) {
  if (process.argv[2] === "--runner-child")
    await runnerChild(resolve(process.argv[3]), resolve(process.argv[4]));
  else if (process.argv[2] === "--metadata")
    console.log(
      JSON.stringify(
        { executionPending: true, versions: await inspectCyrusRuntime(process.argv[3]) },
        null,
        2,
      ),
    );
  else {
    runtimeAllowed();
    assert.ok(process.argv[2], "Supply the prepared public-consumer stage");
    const result = await child(
      process.execPath,
      [join(dirname(thisFile), "native-proof.mjs"), resolve(process.argv[2]), "--cyrus-only"],
      {
        cwd: dirname(thisFile),
        env: process.env,
      },
      240000,
    );
    if (result.code !== 0 || result.timedOut) {
      // Bounded synthetic child output is retained even if startup failed before native run receipts.
      await writeFile(
        join(resolve(process.argv[2]), "cyrus-native-child-failure.json"),
        `${JSON.stringify(result, null, 2)}\n`,
      );
      throw new Error("Isolated Cyrus runtime proof failed; inspect the synthetic stage receipts");
    }
    process.stdout.write(result.stdout);
  }
}
