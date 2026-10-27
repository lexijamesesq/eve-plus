import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommissioningConfig } from "./config.js";
import { createDispatcher } from "./dispatch.js";
import { CommissionStore } from "./store.js";
import { handleWorkerRequest } from "./transport.js";

const owner = { principalId: "owner", verified: true as const };
const worker = { principalId: "worker", verified: true as const };
const auth = {
  principalId: "owner",
  authenticator: "estate",
  principalType: "user",
  attributes: {},
};
const stores: CommissionStore[] = [];
const clients: Client[] = [];
function fixture() {
  const store = new CommissionStore(":memory:");
  stores.push(store);
  store.open(
    owner,
    {
      commissionId: "one",
      spec: { brief: "Update labels", acceptance: ["Tests pass"], privateGuidance: "Owner only" },
    },
    worker,
    {
      originSessionId: "original",
      messages: [{ role: "user", content: "Use the original commissioning context" }],
    },
  );
  const config: CommissioningConfig = {
    dataDir: "/tmp/commissioning-tests",
    namespace: "test",
    workerPrincipalId: "worker",
    authenticateWorker: (request) =>
      request.headers.get("authorization") === "Bearer fixture-secret" ? worker : null,
    resolveSessionPrincipal: (value) =>
      value?.authenticator === "estate" && value.principalId === "owner" ? owner : null,
    resolveDeliveryAuth: () => auth,
  };
  return { store, config };
}
async function clientFor(
  store: CommissionStore,
  config: CommissioningConfig,
  reconcile?: () => Promise<unknown>,
) {
  const client = new Client({ name: "official-test-client", version: "1.0.0" });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL("https://fixture.invalid/commissioning/mcp"), {
      requestInit: { headers: { authorization: "Bearer fixture-secret" } },
      fetch: async (url, init) =>
        handleWorkerRequest(new Request(url, init), { store, config, reconcile }),
    }),
  );
  return client;
}
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  for (const store of stores.splice(0)) store.close();
});

describe("official stateless MCP worker transport", () => {
  it("reads an already recorded answer without invoking an unrelated held reconciliation callback", async () => {
    const { store, config } = fixture();
    store.consult(worker, {
      commissionId: "one",
      questionId: "answered",
      question: { text: "Which?" },
    });
    store.decide(owner, {
      commissionId: "one",
      eventId: "answer",
      target: "question",
      questionId: "answered",
      decision: { answer: "Recorded answer" },
    });
    for (const entry of store.claimOutbox({ consumerId: "settle-answer" }))
      store.acknowledgeOutbox(entry.seq, entry.leaseToken);
    store.open(
      owner,
      { commissionId: "unrelated", spec: { brief: "Other work", acceptance: ["Done"] } },
      worker,
    );
    store.consult(worker, {
      commissionId: "unrelated",
      questionId: "other",
      question: { text: "Other question" },
    });
    let release = () => {};
    let entered = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    config.resolveDeliveryAuth = async () => {
      entered();
      await held;
      return auth;
    };
    const drain = createDispatcher(store, config);
    const background = drain(async () => {});
    await started;
    const reconcile = vi.fn(() => drain(async () => {}));
    const client = await clientFor(store, config, reconcile);
    const pending = client.callTool({
      name: "commission_read",
      arguments: { commissionId: "one" },
    });
    try {
      const outcome = await Promise.race([
        pending.then(() => "response"),
        new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 1000)),
      ]);
      expect(outcome).toBe("response");
      expect(reconcile).not.toHaveBeenCalled();
    } finally {
      release();
      await pending;
      await background;
    }
    expect(JSON.stringify(await pending)).toContain("Recorded answer");
  });

  it("preserves awaited low-level mutation reconciliation after committing the operation", async () => {
    const { store, config } = fixture();
    let release = () => {};
    let entered = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = await clientFor(store, config, async () => {
      entered();
      await held;
    });
    const pending = client.callTool({
      name: "commission_consult",
      arguments: { commissionId: "one", questionId: "held", question: { text: "Which?" } },
    });
    await started;
    expect(store.question(owner, "one", "held").status).toBe("pending");
    try {
      expect(
        await Promise.race([
          pending.then(() => "response"),
          new Promise<string>((resolve) => setTimeout(() => resolve("awaited"), 20)),
        ]),
      ).toBe("awaited");
    } finally {
      release();
    }
    expect((await pending).structuredContent).toMatchObject({ recorded: true });
  });
  it("returns actionable fixed domain reasons while hiding unknown errors and credentials", async () => {
    const { store, config } = fixture();
    const client = await clientFor(store, config);
    const args = { commissionId: "one", questionId: "same", question: { text: "First question" } };
    await client.callTool({ name: "commission_consult", arguments: args });
    const conflict = await client.callTool({
      name: "commission_consult",
      arguments: { ...args, question: { text: "Changed question" } },
    });
    expect(conflict.structuredContent).toMatchObject({
      error: { code: "conflict", message: "Event ID was already used with different input" },
    });
    const read = vi.spyOn(store, "read").mockImplementation(() => {
      throw Object.assign(new Error("credential-must-not-escape"), { code: "forbidden" });
    });
    const unknown = await client.callTool({
      name: "commission_read",
      arguments: { commissionId: "one" },
    });
    expect(unknown.structuredContent).toEqual({
      error: { code: "internal", message: "Commissioning operation failed" },
    });
    expect(JSON.stringify(unknown)).not.toContain("credential-must-not-escape");
    read.mockRestore();
    const report = vi.spyOn(store, "report");
    const uppercase = await client.callTool({
      name: "commission_report",
      arguments: {
        commissionId: "one",
        eventId: "upper",
        kind: "proposal",
        data: {
          summary: "Ready",
          artifact: {
            repository: "https://example.test/repo",
            commit: "A".repeat(40),
            pullRequest: "https://example.test/repo/pull/1",
          },
        },
      },
    });
    expect(uppercase.isError).toBe(true);
    expect(report).not.toHaveBeenCalled();
    report.mockRestore();
  });
  it("advertises only worker tools and authenticates every request", async () => {
    const { store, config } = fixture();
    const client = await clientFor(store, config);
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      "commission_consult",
      "commission_read",
      "commission_report",
    ]);
    const result = await client.callTool({
      name: "commission_read",
      arguments: { commissionId: "one" },
    });
    expect(JSON.stringify(result)).not.toContain("Owner only");
    expect(JSON.stringify(result)).not.toContain("original commissioning context");
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
    config.authenticateWorker = () => null;
    await expect(client.listTools()).rejects.toThrow();
  });
  it("fails closed for credentials mapped to an owner, spoofed fields, and owner tool names", async () => {
    const { store, config } = fixture();
    const response = await handleWorkerRequest(
      new Request("https://fixture.invalid/commissioning/mcp", { method: "POST" }),
      { store, config: { ...config, authenticateWorker: () => owner } },
    );
    expect(response.status).toBe(401);
    const client = await clientFor(store, config);
    expect(
      (await client.callTool({ name: "commission_decide", arguments: { commissionId: "one" } }))
        .isError,
    ).toBe(true);
    expect(
      (
        await client.callTool({
          name: "commission_consult",
          arguments: {
            commissionId: "one",
            questionId: "q",
            question: { text: "Question" },
            owner: "owner",
          },
        })
      ).isError,
    ).toBe(true);
    store.open(
      { verified: true, principalId: "other-owner" },
      { commissionId: "other", spec: { brief: "Other", acceptance: ["Done"] } },
      { verified: true, principalId: "other-worker" },
    );
    const forbidden = await client.callTool({
      name: "commission_read",
      arguments: { commissionId: "other" },
    });
    expect(forbidden.isError).toBe(true);
    expect(JSON.stringify(forbidden)).toContain("not_found");
  });
  it("keeps a durable mutation when delivery fails; retry reuses the event", async () => {
    const { store, config } = fixture();
    const client = await clientFor(store, config, async () => {
      throw new Error("secret failed callback");
    });
    const input = {
      name: "commission_consult",
      arguments: {
        commissionId: "one",
        questionId: "q",
        question: { text: "Which label?", options: ["A", "B"] },
      },
    };
    const first = await client.callTool(input);
    expect(first.structuredContent).toMatchObject({ recorded: true });
    await client.callTool(input);
    expect(store.read(owner, "one").questions).toHaveLength(1);
    const drain = createDispatcher(store, config);
    const deliveries: unknown[] = [];
    await drain(async (delivery) => {
      deliveries.push(delivery);
    });
    await drain(async (delivery) => {
      deliveries.push(delivery);
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      history: [{ role: "user", text: "Use the original commissioning context" }],
      auth: { principalId: "owner" },
    });
    expect(JSON.stringify(deliveries[0])).toContain("Owner only");
    store.decide(owner, {
      commissionId: "one",
      eventId: "answer",
      target: "question",
      questionId: "q",
      decision: { answer: "A" },
    });
    const read = await client.callTool({
      name: "commission_read",
      arguments: { commissionId: "one" },
    });
    expect(JSON.stringify(read)).toContain("answered");
    expect(JSON.stringify(read)).not.toContain("Owner only");
  });
  it("retries owner delivery after callback failure and rejects mismatched delivery identity", async () => {
    const { store, config } = fixture();
    store.consult(worker, { commissionId: "one", questionId: "q", question: { text: "Ready?" } });
    let attempts = 0;
    const drain = createDispatcher(store, config);
    await drain(async () => {
      attempts++;
      throw new Error("offline");
    });
    config.resolveDeliveryAuth = () => ({ ...auth, principalId: "wrong" });
    await drain(async () => {
      attempts++;
    });
    expect(attempts).toBe(1);
    config.resolveDeliveryAuth = () => auth;
    await drain(async () => {
      attempts++;
    });
    expect(attempts).toBe(2);
    await drain(async () => {
      attempts++;
    });
    expect(attempts).toBe(2);
  });
  it("accepts a host-verified commissioner mapping without equating it to the actual initiating principal", async () => {
    const { store, config } = fixture();
    config.resolveDeliveryAuth = () => ({ ...auth, principalId: "actual-agent-app" });
    config.resolveSessionPrincipal = (value) =>
      value?.authenticator === "estate" && value.principalId === "actual-agent-app" ? owner : null;
    store.consult(worker, { commissionId: "one", questionId: "q", question: { text: "Which?" } });
    let count = 0;
    await createDispatcher(
      store,
      config,
    )(async (delivery) => {
      count++;
      expect(delivery.auth.principalId).toBe("actual-agent-app");
      expect(delivery.entry.recipient).toBe("owner");
    });
    expect(count).toBe(1);
    expect(store.read(owner, "one").notification?.pending).toBe(0);
  });
});
