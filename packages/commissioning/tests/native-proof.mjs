import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createProbeControlCredential, runCyrusProbe } from "./cyrus-runtime-proof.mjs";
import { readNativeStream } from "./read-native-stream.mjs";
import { verifyNativeStream } from "./verify-native-stream.mjs";

assert.ok(process.argv[2], "Supply the prepared clean-consumer stage");
assert.equal(
  process.env.COMMISSIONING_PROOF_ALLOW_RUNTIME,
  "1",
  "Explicitly opt into an isolated synthetic runtime",
);
const stage = resolve(process.argv[2]);
const preparation = JSON.parse(await readFile(join(stage, "native-preparation.json"), "utf8"));
assert.equal(
  preparation.platform,
  process.platform,
  "Rebuild the staged consumer on the runtime platform",
);
assert.equal(
  preparation.architecture,
  process.arch,
  "Native SQLite must match the runtime architecture",
);
const consumer = join(stage, "consumer");
const requireConsumer = createRequire(join(consumer, "package.json"));
const load = (name) => import(pathToFileURL(requireConsumer.resolve(name)).href);
const { Client } = await load("@modelcontextprotocol/sdk/client/index.js");
const { Client: EveClient } = await load("eve/client");
const { StreamableHTTPClientTransport } = await load(
  "@modelcontextprotocol/sdk/client/streamableHttp.js",
);
const Database = requireConsumer("better-sqlite3");
const config = JSON.parse(await readFile(join(stage, "native-config.json"), "utf8"));
const controlBearer = await createProbeControlCredential(stage, config);

const cyrusEnvironmentKeys = [
  "EXAMPLE_LINEAR_TOKEN",
  "EXAMPLE_CYRUS_DELEGATE_ID",
  "EXAMPLE_MCP_ENDPOINT",
  "FIXTURE_LINEAR_URL",
];
const base = new URL(config.EXAMPLE_MCP_ENDPOINT).origin;
const nativeHistoryClient = new EveClient({
  host: base,
  auth: { basic: { username: "example-commissioner", password: config.EXAMPLE_OWNER_PASSWORD } },
});
const runRoot = join(stage, `native-run-${Date.now()}`);
await mkdir(runRoot);
const children = new Set();
const cases = [];
const recoveryOnly = process.argv.includes("--recovery-only");
const journal = [];
let work = {
  id: "canonical-example-issue",
  url: "https://linear.app/example/issue/ENG-123",
  description: "Objective: preserve this work\nDone When: preserve these criteria",
  delegate: null,
};
const originalDescription = work.description;
let loseMutationResponse = false;
let contractComments = [];
const delegationCount = () =>
  journal.filter((entry) => entry.query?.startsWith("mutation CommissionActivate")).length;
const contractCount = () =>
  journal.filter((entry) => entry.query?.startsWith("mutation CommissionContract")).length;
const linear = createServer(async (request, response) => {
  const entry = {};
  journal.push(entry); // Count every external request immediately, including rejected or incomplete requests.
  try {
    const parts = [];
    for await (const part of request) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts).toString());
    assert.equal(request.headers.authorization, `Bearer ${config.EXAMPLE_LINEAR_TOKEN}`);
    Object.assign(entry, { query: body.query, variables: body.variables });
    const encoded = JSON.stringify(body);
    for (const sentinel of [
      "Private commissioner discussion",
      "ORIGINAL_CONTEXT_SENTINEL",
      "synthetic-owner-only",
      "synthetic-worker-only",
    ])
      assert.equal(
        encoded.includes(sentinel),
        false,
        `Private value reached external work service: ${sentinel}`,
      );
    response.setHeader("content-type", "application/json");
    if (body.query.startsWith("mutation CommissionContract")) {
      assert.equal(body.variables.issueId, work.id);
      assert.equal(
        contractComments.some((comment) => comment.id === body.variables.commentId),
        false,
      );
      contractComments.push({ id: body.variables.commentId, body: body.variables.body });
      response.end(JSON.stringify({ data: { commentCreate: { success: true } } }));
    } else if (body.query.startsWith("mutation CommissionActivate")) {
      assert.deepEqual(Object.keys(body.variables).sort(), ["delegateId", "id"]);
      assert.equal(body.variables.id, work.id);
      assert.equal(contractComments.length, 1, "Delegation requires the recorded contract comment");
      work = { ...work, delegate: { id: body.variables.delegateId } };
      assert.equal(work.description, originalDescription);
      if (loseMutationResponse) {
        loseMutationResponse = false;
        request.socket.destroy();
        return;
      }
      response.end(JSON.stringify({ data: { issueUpdate: { success: true } } }));
    } else {
      assert.ok(body.query.startsWith("query CommissionWorkRecord"));
      const matches = contractComments.filter(
        (comment) =>
          comment.id === body.variables.commentId || comment.body.includes("<!-- eve-commission:"),
      );
      response.end(
        JSON.stringify({
          data: {
            issue: {
              ...work,
              comments: {
                nodes: matches.slice(0, 2),
                pageInfo: { hasNextPage: matches.length > 2 },
              },
            },
          },
        }),
      );
    }
  } catch (error) {
    Object.assign(entry, { failure: error.message });
    response.writeHead(500);
    response.end("Synthetic service rejected a request");
  }
});
linear.listen(0, "127.0.0.1");
await once(linear, "listening");
const linearUrl = `http://127.0.0.1:${linear.address().port}/graphql`;
async function until(fn, label, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timeout: ${label}`);
}
const audit = async (root) =>
  (await readFile(join(root, "audit.jsonl"), "utf8").catch(() => ""))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
function inspect(root, sql, ...args) {
  const db = new Database(join(root, "data/example-commissions/commissions.sqlite"), {
    readonly: true,
  });
  try {
    return db.prepare(sql).all(...args);
  } finally {
    db.close();
  }
}
async function start(root, extra = {}) {
  await mkdir(root, { recursive: true });
  const log = createWriteStream(join(root, `server-${Date.now()}.log`));
  const childEnv = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: root,
    ...config,
    EXAMPLE_DATA_DIR: join(root, "data"),
    FIXTURE_AUDIT: join(root, "audit.jsonl"),
    FIXTURE_LINEAR_URL: linearUrl,
    FIXTURE_DELIVERY_HOLD: join(root, "hold-delivery"),
    FIXTURE_FAULT_MARKER: join(root, "fault-marker"),
    HOST: "127.0.0.1",
    PORT: new URL(base).port,
    WORKFLOW_LOCAL_BASE_URL: base,
    ...extra,
  };
  if (childEnv.EXAMPLE_WORKER_MODE === "neutral") {
    for (const key of cyrusEnvironmentKeys) delete childEnv[key];
    assert.ok(
      cyrusEnvironmentKeys.every((key) => !(key in childEnv)),
      "Neutral runtime must have no Cyrus service configuration",
    );
  }
  const child = spawn(
    process.execPath,
    [join(stage, "native-output", childEnv.EXAMPLE_WORKER_MODE, "server/index.mjs")],
    {
      cwd: root,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.add(child);
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  child.once("exit", () => {
    children.delete(child);
    log.end();
  });
  await until(async () => {
    assert.equal(child.exitCode, null, "Native server exited during startup");
    try {
      return (await fetch(`${base}/eve/v1/health`)).ok;
    } catch {
      return false;
    }
  }, "native startup");
  return child;
}
async function stop(child) {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      await exited;
    } finally {
      clearTimeout(timeout);
    }
  }
}
async function connect(token) {
  token ??= await controlBearer();
  const client = new Client({ name: "public-qualification-worker", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(config.EXAMPLE_MCP_ENDPOINT), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}
async function call(client, name, args) {
  const response = await client.callTool({ name, arguments: args });
  assert.equal(response.isError, undefined, JSON.stringify(response));
  return response.structuredContent.result;
}
async function open(root) {
  const response = await fetch(`${base}/fixture/open`, { method: "POST" });
  assert.equal(response.ok, true);
  const { sessionId } = await response.json();
  const opened = await until(
    async () => (await audit(root)).find((item) => item.stage === "opened"),
    "native authored open",
  );
  assert.equal(opened.isError, false);
  return { id: opened.output.commissionId, origin: sessionId };
}
const consult = (client, id, questionId, text = "Which behavior meets the acceptance criteria?") =>
  call(client, "commission_consult", { commissionId: id, questionId, question: { text } });
const read = (client, id) => call(client, "commission_read", { commissionId: id });
const answered = (client, id, questionId) =>
  until(
    async () =>
      (await read(client, id)).questions.find(
        (question) => question.questionId === questionId && question.status === "answered",
      ),
    `answer ${questionId}`,
  );
try {
  if (!process.argv.includes("--cyrus-only") && !recoveryOnly) {
    const neutralRoot = join(runRoot, "neutral-default");
    const journalBefore = journal.length;
    const neutralServer = await start(neutralRoot, { EXAMPLE_WORKER_MODE: "neutral" });
    let neutralClient;
    try {
      const { id } = await open(neutralRoot);
      const response = await fetch(`${base}/fixture/read`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commissionId: id }),
      });
      assert.equal(response.ok, true);
      const ownerRead = await until(
        async () => (await audit(neutralRoot)).find((entry) => entry.stage === "owner-read"),
        "neutral native owner read",
      );
      assert.equal(ownerRead.isError, false);
      assert.equal(ownerRead.output.commissionId, id);
      assert.equal(ownerRead.output.spec.privateGuidance, "Private commissioner discussion");
      neutralClient = await connect();
      const workerRead = await read(neutralClient, id);
      assert.equal(workerRead.commissionId, id);
      assert.equal(workerRead.status, "working");
      assert.equal(workerRead.spec.privateGuidance, undefined);
      assert.equal(
        inspect(neutralRoot, "SELECT count(*) n FROM worker_bindings WHERE commission_id=?", id)[0]
          .n,
        0,
      );
      assert.equal(
        inspect(
          neutralRoot,
          "SELECT count(*) n FROM events WHERE kind='worker_activation_requested'",
        )[0].n,
        0,
      );
      assert.equal(
        inspect(
          neutralRoot,
          "SELECT count(*) n FROM outbox WHERE kind='worker_activation_requested'",
        )[0].n,
        0,
      );
    } finally {
      await neutralClient?.close();
      await stop(neutralServer);
    }
    assert.equal(
      journal.length,
      journalBefore,
      "Neutral open/read must make zero synthetic service requests",
    );
    cases.push({
      case: "native-neutral-default",
      mode: "neutral",
      passed: true,
      nativeOwnerOpenRead: true,
      workerMcpRead: true,
      cyrusServiceEnvironmentAbsent: true,
      noWorkerBinding: true,
      noActivationIntent: true,
      syntheticServiceRequests: 0,
    });
  }
  const normalRoot = join(runRoot, "normal");
  let server = await start(normalRoot);
  let client;
  try {
    const { id, origin } = await open(normalRoot);
    client = await connect();
    if (process.argv.includes("--cyrus-only")) {
      await until(() => work.delegate, "actual scheduled handoff before Cyrus intake", 90000);
      assert.equal(contractComments.length, 1);
      cases.push(
        await runCyrusProbe(stage, {
          endpoint: config.EXAMPLE_MCP_ENDPOINT,
          commissionId: id,
          dataDir: join(normalRoot, "data"),
          issue: { ...work },
          contractComments: structuredClone(contractComments),
        }),
      );
    } else if (recoveryOnly) {
      await consult(client, id, "recovery-before");
      await answered(client, id, "recovery-before");
      const canonicalTurns = async () =>
        (await audit(normalRoot)).filter(
          (entry) =>
            entry.stage === "native-turn" &&
            entry.channel?.continuationToken === `commissioning__commissioning:${id}`,
        );
      const oldCanonical = (await canonicalTurns())[0]?.sessionId;
      assert.ok(oldCanonical && oldCanonical !== origin);
      const contextBefore = JSON.parse(
        inspect(normalRoot, "SELECT value FROM contexts WHERE commission_id=?", id)[0].value,
      );
      assert.deepEqual(contextBefore.source, { originSessionId: origin });
      // Exact-ID public reset; unchanged native dispatcher then owns canonical address creation.
      await nativeHistoryClient.sessions.attach(oldCanonical).reset({
        reason: "Authorized synthetic commissioner recovery",
        signal: AbortSignal.timeout(45000),
      });
      await consult(client, id, "recovery-created");
      await answered(client, id, "recovery-created");
      const replacementId = (await canonicalTurns()).at(-1)?.sessionId;
      assert.ok(replacementId && replacementId !== oldCanonical && replacementId !== origin);
      const recovery = {
        commissionId: id,
        expectedActiveSessionId: origin,
        replacementSessionId: replacementId,
        source: contextBefore.source,
      };
      const rebind = (input, authenticated = true) =>
        fetch(`${base}/fixture/rebind`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(authenticated
              ? {
                  authorization: `Basic ${Buffer.from(`example-commissioner:${config.EXAMPLE_OWNER_PASSWORD}`).toString("base64")}`,
                }
              : {}),
          },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(45000),
        });
      assert.equal((await rebind(recovery, false)).status, 401);
      assert.equal(
        (await rebind({ ...recovery, source: { originSessionId: "foreign-source" } })).status,
        403,
      );
      assert.equal((await rebind({ ...recovery, replacementSessionId: origin })).status, 403);
      assert.equal(
        inspect(normalRoot, "SELECT count(*) n FROM events WHERE kind='session_rebound'")[0].n,
        0,
      );
      const rebound = await rebind(recovery);
      assert.equal(rebound.status, 200);
      assert.equal((await rebound.json()).activeSessionId, replacementId);
      const contextAfter = JSON.parse(
        inspect(normalRoot, "SELECT value FROM contexts WHERE commission_id=?", id)[0].value,
      );
      assert.deepEqual(contextAfter, { ...contextBefore, activeSessionId: replacementId });
      await consult(client, id, "recovery-old-denial", "FINAL_JSON_ONLY");
      await until(
        async () =>
          (await audit(normalRoot)).find(
            (entry) =>
              entry.stage === "final-json-only" && entry.eventId === "question:recovery-old-denial",
          ),
        "replacement pending control",
      );
      const bound = await fetch(`${base}/fixture/bound`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commissionId: id, questionId: "recovery-old-denial" }),
      });
      assert.equal(bound.ok, true);
      assert.equal((await bound.json()).sessionId, origin);
      const denial = await until(
        async () => (await audit(normalRoot)).find((entry) => entry.stage === "bound-result"),
        "old original native session denial",
      );
      assert.equal(denial.isError, true);
      assert.match(String(denial.output), /different active session/);
      assert.equal(
        (await read(client, id)).questions.find(
          (question) => question.questionId === "recovery-old-denial",
        ).status,
        "pending",
      );
      // Positive counterpart targets the same still-pending question on the exact authorized replacement.
      await nativeHistoryClient.sessions
        .attach(replacementId)
        .send(`BOUND:${JSON.stringify({ commissionId: id, questionId: "recovery-old-denial" })}`, {
          turnPolicy: "queue",
          signal: AbortSignal.timeout(45000),
        });
      assert.equal(
        (await answered(client, id, "recovery-old-denial")).answer.answer,
        "bound authorized answer",
      );
      assert.equal(
        inspect(
          normalRoot,
          "SELECT count(*) n FROM events WHERE commission_id=? AND kind='decision' AND json_extract(payload,'$.questionId')=?",
          id,
          "recovery-old-denial",
        )[0].n,
        1,
      );
      await consult(client, id, "recovery-after");
      assert.equal(
        (await answered(client, id, "recovery-after")).answer.answer,
        "Use the recorded acceptance criteria",
      );
      assert.equal((await canonicalTurns()).at(-1).sessionId, replacementId);
      const stream = await readNativeStream(nativeHistoryClient, replacementId);
      await writeFile(join(normalRoot, "native-session-stream.jsonl"), stream);
      const events = stream.trim().split("\n").map(JSON.parse);
      assert.equal(events.filter((event) => event.type === "history.imported").length, 1);
      assert.equal(
        events.filter(
          (event) =>
            event.type === "message.received" &&
            typeof event.data?.message === "string" &&
            event.data.message.includes('"eventId":"question:recovery-after"'),
        ).length,
        1,
      );
      assert.equal(
        inspect(normalRoot, "SELECT count(*) n FROM events WHERE kind='session_rebound'")[0].n,
        1,
      );
      cases.push({
        case: "native-canonical-owner-recovery",
        passed: true,
        actualPublicExactSessionReset: true,
        unchangedDefaultCanonicalCreate: true,
        authenticatedSourceCheckedCas: true,
        unauthenticatedDenied: true,
        wrongSourceDenied: true,
        foreignReplacementDenied: true,
        immutableProvenance: true,
        oldOriginalSessionDenied: true,
        samePendingQuestionReplacementPositive: true,
        newQuestionDecidedOnReplacement: true,
        boundedPublicStreamReader: true,
        limit:
          "Reset, default creation and CAS are separate operations. The first replacement question may answer before explicit rebind; no atomicity claim.",
      });
    } else {
      assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), [
        "commission_consult",
        "commission_read",
        "commission_report",
      ]);
      await assert.rejects(() => connect("incorrect-worker-credential"));
      const unknownOwner = await client.callTool({
        name: "commission_decide",
        arguments: { commissionId: id },
      });
      assert.equal(unknownOwner.isError, true);
      await Promise.all([consult(client, id, "overlap-a"), consult(client, id, "overlap-b")]);
      await answered(client, id, "overlap-a");
      await answered(client, id, "overlap-b");
      const commits = JSON.parse(await readFile(join(stage, "fixture-commits.json"), "utf8"));
      for (const [index, commit] of commits.entries()) {
        await call(client, "commission_report", {
          commissionId: id,
          eventId: `proposal-${index}`,
          kind: "proposal",
          data: {
            summary: "Worker claims all criteria pass",
            artifact: {
              repository: "https://example.test/repo",
              commit,
              pullRequest: "https://example.test/repo/pull/1",
            },
          },
        });
        await until(
          async () =>
            (await read(client, id)).status === (index ? "accepted" : "revision_requested"),
          "independent immutable artifact decision",
        );
      }
      const view = await read(client, id);
      assert.equal(JSON.stringify(view).includes("Private commissioner discussion"), false);
      const notifications = (await audit(normalRoot)).filter(
        (entry) => entry.stage === "owner-notification",
      );
      assert.ok(
        notifications.length > 0 && notifications.every((entry) => entry.snapshotCount === 1),
      );
      const continuation = (await audit(normalRoot)).find(
        (entry) => entry.stage === "native-turn" && entry.sessionId !== origin,
      )?.sessionId;
      assert.ok(continuation);
      const stream = await readNativeStream(nativeHistoryClient, continuation);
      await writeFile(join(normalRoot, "native-session-stream.jsonl"), stream);
      cases.push({
        case: "native-default-workflow",
        passed: true,
        ...verifyNativeStream(stream),
        nativeOpenReadDecide: true,
        workerPrivateProjection: true,
        rejectedFailingCommit: true,
        acceptedCorrectedCommit: true,
      });
      assert.equal(
        journal.some((entry) => entry.failure),
        false,
      );
      assert.equal(delegationCount(), 1);
      assert.equal(contractCount(), 1);
      assert.equal(work.description, originalDescription);
      cases.push({
        case: "actual-public-cyrus-handoff",
        passed: true,
        preservedWorkDescription: true,
        confirmedDelegation: true,
        delegationMutations: 1,
        contractComments: 1,
        limit: "Linear HTTP behavior simulated; no live webhook/worker-start claim",
      });
    }
  } finally {
    await client?.close();
    await stop(server);
  }
  if (!process.argv.includes("--cyrus-only") && !recoveryOnly) {
    // Reset only the synthetic external service between independent work records.
    work = { ...work, description: originalDescription, delegate: null };
    contractComments = [];
    const root = join(runRoot, "session-denial");
    server = await start(root);
    client = await connect();
    try {
      const { id } = await open(root);
      await consult(client, id, "json-only", "FINAL_JSON_ONLY");
      await until(
        async () => (await audit(root)).find((entry) => entry.stage === "final-json-only"),
        "JSON-only final response",
      );
      assert.equal((await read(client, id)).questions[0].status, "pending");
      const control = (path) =>
        fetch(`${base}/fixture/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ commissionId: id, questionId: "json-only" }),
        });
      await control("unbound");
      const denial = await until(
        async () => (await audit(root)).find((entry) => entry.stage === "unbound-result"),
        "real-question unrelated-session denial",
      );
      assert.equal(denial.isError, true);
      assert.match(String(denial.output), /Commission is not bound to this trusted session/);
      assert.equal((await read(client, id)).questions[0].status, "pending");
      await control("bound");
      assert.equal(
        (await answered(client, id, "json-only")).answer.answer,
        "bound authorized answer",
      );
      cases.push({
        case: "valid-question-session-control",
        passed: true,
        finalTextCannotDecide: true,
        unrelatedSessionDenied: true,
        originalSessionPositiveCounterpart: true,
      });
    } finally {
      await client.close();
      await stop(server);
    }
    work = { ...work, description: originalDescription, delegate: null };
    contractComments = [];
    const scheduledRoot = join(runRoot, "schedule-only");
    await mkdir(scheduledRoot);
    await writeFile(join(scheduledRoot, "hold-delivery"), "hold");
    server = await start(scheduledRoot);
    client = await connect();
    try {
      const { id } = await open(scheduledRoot);
      await consult(client, id, "schedule-question");
      assert.equal(
        inspect(scheduledRoot, "SELECT answer FROM questions WHERE id='schedule-question'")[0]
          .answer,
        null,
      );
      await client.close();
      client = undefined;
      await rm(join(scheduledRoot, "hold-delivery"));
      // No MCP operation during this wait: only a genuine scheduled drain can notify the owner.
      await until(
        () =>
          inspect(scheduledRoot, "SELECT answer FROM questions WHERE id='schedule-question'")[0]
            .answer,
        "actual native cron delivery",
        90000,
      );
      cases.push({
        case: "default-schedule-only",
        passed: true,
        noMcpReconciliationObserver: true,
      });
    } finally {
      await client?.close();
      await stop(server);
    }
    const emptyRoot = join(runRoot, "empty-schedule");
    server = await start(emptyRoot);
    try {
      await new Promise((resolve) => setTimeout(resolve, 65000));
      assert.equal(
        (await audit(emptyRoot)).filter((entry) => entry.stage === "native-turn").length,
        0,
      );
      assert.equal(inspect(emptyRoot, "SELECT count(*) n FROM commissions")[0].n, 0);
      assert.equal(inspect(emptyRoot, "SELECT count(*) n FROM outbox")[0].n, 0);
      cases.push({
        case: "empty-default-schedule",
        passed: true,
        emptyCronCreatesNoTurn: true,
        schedulerCreatedLedgerWithoutSession: true,
      });
    } finally {
      await stop(server);
    }
    work = { ...work, description: originalDescription, delegate: null };
    contractComments = [];
    const retryRoot = join(runRoot, "unknown-handoff");
    loseMutationResponse = true;
    const mutationStart = delegationCount();
    const commentStart = contractCount();
    server = await start(retryRoot);
    client = await connect();
    try {
      const { id } = await open(retryRoot);
      // Only mutations schedule reconciliation. Reads remain side-effect-free.
      await call(client, "commission_report", {
        commissionId: id,
        eventId: "activation-trigger",
        kind: "checkpoint",
        data: { summary: "Synthetic activation reconciliation" },
      });
      await until(() => work.delegate, "external commit with lost response");
      await until(
        () =>
          inspect(
            retryRoot,
            "SELECT failure_class FROM outbox WHERE kind='worker_activation_requested'",
          )[0]?.failure_class === "worker_handoff_failed",
        "uncertain activation retained pending",
      );
      await call(client, "commission_report", {
        commissionId: id,
        eventId: "activation-retry",
        kind: "checkpoint",
        data: { summary: "Synthetic retry after uncertain outcome" },
      });
      await until(
        () =>
          inspect(
            retryRoot,
            "SELECT count(*) n FROM outbox WHERE delivered=0 AND kind='worker_activation_requested'",
          )[0].n === 0,
        "matching handoff readback acknowledged",
      );
      assert.equal(
        inspect(
          retryRoot,
          "SELECT count(*) n FROM outbox WHERE delivered=0 AND kind='worker_activation_requested'",
        )[0].n,
        0,
      );
      assert.equal(delegationCount() - mutationStart, 1);
      assert.equal(contractCount() - commentStart, 1);
      cases.push({
        case: "unknown-handoff-outcome",
        passed: true,
        matchingReadbackAcknowledged: true,
        oneContractComment: contractCount() - commentStart === 1,
        mutationsTriggerReconciliation: true,
        noRepeatedMutation: true,
      });
    } finally {
      await client.close();
      await stop(server);
    }
    work = { ...work, description: originalDescription, delegate: null };
    contractComments = [];
    const restartRoot = join(runRoot, "send-before-ack-restart");
    server = await start(restartRoot, { FIXTURE_FAULT_BEFORE_ACK: "1" });
    client = await connect();
    try {
      const { id, origin } = await open(restartRoot);
      await call(client, "commission_report", {
        commissionId: id,
        eventId: "activation-before-fault",
        kind: "checkpoint",
        data: { summary: "Activate before isolated owner-send fault" },
      });
      await until(() => work.delegate, "activation before separately labelled owner-send fault");
      await Promise.all([
        once(server, "exit", { signal: AbortSignal.timeout(45000) }),
        consult(client, id, "restart-question").catch(() => {}),
      ]);
      assert.equal(server.signalCode, "SIGKILL");
      assert.match(
        await readFile(join(restartRoot, "fault-marker"), "utf8"),
        /after-native-send-before-ack/,
      );
      await client.close();
      client = undefined;
      const questionDecisionCount = () =>
        inspect(
          restartRoot,
          "SELECT count(*) n FROM events WHERE commission_id=? AND kind='decision' AND json_extract(payload,'$.target')='question' AND json_extract(payload,'$.questionId')=?",
          id,
          "restart-question",
        )[0].n;
      // A queued native send can return before or after the authored decision commits.
      const decisionCountAtCrash = questionDecisionCount();
      assert.ok(decisionCountAtCrash === 0 || decisionCountAtCrash === 1);
      server = await start(restartRoot);
      client = await connect();
      // Honor the real lease, then retry an existing idempotent mutation to schedule reconciliation.
      // Reads stay observational; the independent schedule-only case above uses no MCP observer.
      let workerRetryTriggered = false;
      await until(
        async () => {
          await read(client, id);
          const receipt = inspect(
            restartRoot,
            "SELECT lease_until,delivered FROM outbox WHERE commission_id=? AND event_id=?",
            id,
            "question:restart-question",
          )[0];
          if (
            !workerRetryTriggered &&
            receipt?.delivered === 0 &&
            receipt.lease_until <= Date.now()
          ) {
            workerRetryTriggered = true;
            await call(client, "commission_report", {
              commissionId: id,
              eventId: "activation-before-fault",
              kind: "checkpoint",
              data: { summary: "Activate before isolated owner-send fault" },
            });
          }
          const decisions = questionDecisionCount();
          assert.ok(
            decisions <= 1,
            "The restarted question must have at most one canonical decision",
          );
          return (
            inspect(restartRoot, "SELECT count(*) n FROM outbox WHERE delivered=0")[0].n === 0 &&
            decisions === 1
          );
        },
        "unacknowledged native delivery restart recovery",
        160000,
      );
      assert.equal(questionDecisionCount(), 1);
      const continuation = (await audit(restartRoot)).find(
        (entry) => entry.stage === "native-turn" && entry.sessionId !== origin,
      )?.sessionId;
      assert.ok(continuation);
      const stream = await readNativeStream(nativeHistoryClient, continuation);
      await writeFile(join(restartRoot, "native-session-stream.jsonl"), stream);
      const questionTurns = stream
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse)
        .filter((event) => {
          if (event.type !== "message.received") return false;
          try {
            return JSON.parse(event.data.message).eventId === "question:restart-question";
          } catch {
            return false;
          }
        });
      assert.equal(
        questionTurns.length,
        1,
        "The replayed question must not create a duplicate native turn",
      );
      cases.push({
        case: "actual-process-restart",
        passed: true,
        signal: "SIGKILL",
        reconciliation:
          "Idempotent worker checkpoint retry after observed lease expiry, or native cron",
        actualLeaseUnchanged: true,
        questionId: "restart-question",
        decisionCountAtCrash,
        finalCanonicalDecisionCount: questionDecisionCount(),
        ledgerAndWorldPreserved: true,
        recentDeliveryKeySuppressedDuplicateOwnerTurn: true,
        limit: "Within retained native idempotency-key window only",
      });
    } finally {
      await client?.close();
      await stop(server);
    }
  }
  const receipt = {
    passed: true,
    tarballSha256: preparation.tarballSha256,
    node: process.version,
    cases,
    limits:
      "Synthetic external Linear service; deterministic Eve/loopback Cyrus provider. No production wake/service credentials/live model. Known generic backlog remains outside this qualification.",
  };
  await writeFile(join(runRoot, "result.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify({ runRoot, ...receipt }, null, 2));
} catch (error) {
  await writeFile(
    join(runRoot, "result.json"),
    `${JSON.stringify(
      {
        passed: false,
        tarballSha256: preparation.tarballSha256,
        completedCases: cases,
        failure: error.message,
      },
      null,
      2,
    )}\n`,
  );
  throw error;
} finally {
  for (const child of children) await stop(child);
  await writeFile(
    join(runRoot, "synthetic-linear-journal.json"),
    `${JSON.stringify(journal, null, 2)}\n`,
  );
  linear.closeAllConnections();
  await new Promise((resolve) => linear.close(resolve));
}
