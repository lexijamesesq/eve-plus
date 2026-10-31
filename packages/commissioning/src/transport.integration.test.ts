import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommissionStore } from "./store.js";
import { handleWorkerRequest } from "./transport.js";
import type { Commissioner } from "./types.js";

// The worker's side of a commission through the official MCP client, over the endpoint's real request handler.
const owner: Commissioner = {
  id: "ops-agent",
  conversation: { channel: "C-private", thread: "1.0" },
};
const stores: CommissionStore[] = [];
const clients: Client[] = [];
function fixture() {
  const store = new CommissionStore(":memory:");
  stores.push(store);
  store.open(owner, {
    commissionId: "one",
    spec: { brief: "Update labels", acceptance: ["Tests pass"] },
    workReference: { kind: "linear-issue", id: "ENG-1" },
    connectorId: "test-worker",
    binding: { issue: "ENG-1" },
  });
  return store;
}
async function clientFor(
  store: CommissionStore,
  options: {
    reconcile?: () => Promise<unknown>;
    authenticated?: () => boolean;
    open?: () => CommissionStore;
  } = {},
) {
  const client = new Client({ name: "test-worker", version: "1.0.0" });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL("https://agent.invalid/commissioning/mcp"), {
      requestInit: { headers: { authorization: "Bearer worker-token" } },
      fetch: async (url, init) =>
        handleWorkerRequest(new Request(url, init), {
          store: options.open ?? (() => store),
          authenticateWorker: (request) =>
            (options.authenticated?.() ?? true) &&
            request.headers.get("authorization") === "Bearer worker-token",
          reconcile: options.reconcile,
        }),
    }),
  );
  return client;
}
const call = async (client: Client, name: string, args: Record<string, unknown>) =>
  (await client.callTool({ name, arguments: args })).structuredContent as {
    result?: Record<string, unknown>;
    error?: { code: string; message: string };
  };
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  for (const store of stores.splice(0)) store.close();
});

describe("the worker endpoint", () => {
  it("serves only the worker's tools, authenticates every request before opening the store, and never shows the conversation", async () => {
    const store = fixture();
    let authenticated = true;
    const open = vi.fn(() => store);
    const client = await clientFor(store, { authenticated: () => authenticated, open });
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "commission_consult",
      "commission_read",
      "commission_report",
    ]);
    // A client sees only what's published, so every tool must publish its arguments. A report built from the
    // published schema alone has to be accepted.
    type Published = {
      properties?: Record<string, Published>;
      enum?: string[];
      required?: string[];
    };
    for (const tool of tools)
      expect(Object.keys((tool.inputSchema as Published).properties ?? {}), tool.name).toContain(
        "commissionId",
      );
    const report = tools.find((tool) => tool.name === "commission_report")
      ?.inputSchema as Published;
    const kinds = report.properties?.kind?.enum ?? [];
    expect([...kinds].sort()).toEqual(["checkpoint", "failure", "proposal"]);
    expect(Object.keys(report.properties?.data?.properties ?? {}).sort()).toEqual([
      "artifact",
      "summary",
    ]);
    const checkpoint = await client.callTool({
      name: "commission_report",
      arguments: {
        commissionId: "one",
        eventId: "published",
        kind: kinds.find((kind) => kind === "checkpoint"),
        data: { summary: "Started from the published schema" },
      },
    });
    expect(checkpoint.structuredContent).toMatchObject({
      recorded: true,
      result: { status: "working" },
    });
    const read = await client.callTool({
      name: "commission_read",
      arguments: { commissionId: "one" },
    });
    expect(JSON.stringify(read)).toContain("Update labels");
    expect(JSON.stringify(read)).not.toContain("C-private");
    authenticated = false;
    const opened = open.mock.calls.length;
    await expect(client.listTools()).rejects.toThrow();
    expect(open).toHaveBeenCalledTimes(opened);
  });

  it("carries a question, its answer, a proposal and a revision between worker and commissioner", async () => {
    const reconcile = vi.fn(async () => {
      throw new Error("delivery is down");
    });
    const store = fixture();
    const client = await clientFor(store, { reconcile });
    const consult = {
      commissionId: "one",
      questionId: "q",
      question: { text: "Which label?", options: ["A", "B"] },
    };
    expect(await call(client, "commission_consult", consult)).toMatchObject({
      result: { status: "pending" },
    });
    // A failed delivery doesn't undo the write, and a retry doesn't repeat it.
    await call(client, "commission_consult", consult);
    expect(store.read("one").questions).toHaveLength(1);
    expect(reconcile).toHaveBeenCalledTimes(2);
    store.decide(owner, {
      commissionId: "one",
      eventId: "answer",
      target: "question",
      questionId: "q",
      decision: { answer: "A" },
    });
    const answered = await call(client, "commission_read", { commissionId: "one" });
    expect(answered.result).toMatchObject({ questions: [{ status: "answered", answer: "A" }] });
    expect(reconcile).toHaveBeenCalledTimes(2);
    const proposal = {
      commissionId: "one",
      eventId: "p1",
      kind: "proposal",
      data: {
        summary: "Labels updated",
        artifact: {
          repository: "https://github.com/example/repo",
          commit: "b".repeat(40),
          pullRequest: "https://github.com/example/repo/pull/7",
        },
      },
    };
    expect(await call(client, "commission_report", proposal)).toMatchObject({
      result: { status: "needs_review" },
    });
    store.decide(owner, {
      commissionId: "one",
      eventId: "revise",
      target: "proposal",
      proposalId: "p1",
      decision: { verdict: "revise", feedback: "Keep the old label as an alias" },
    });
    const revision = await call(client, "commission_read", {
      commissionId: "one",
      after: (answered.result as { nextCursor: number }).nextCursor,
    });
    expect(revision.result).toMatchObject({ status: "revision_requested" });
    expect(JSON.stringify(revision.result)).toContain("Keep the old label as an alias");
  });

  it("gives the worker the store's own reasons, hides anything else, and refuses invalid input before the store", async () => {
    const store = fixture();
    const client = await clientFor(store);
    const args = { commissionId: "one", questionId: "same", question: { text: "First question" } };
    await call(client, "commission_consult", args);
    expect(
      await call(client, "commission_consult", { ...args, question: { text: "Changed" } }),
    ).toEqual({
      error: { code: "conflict", message: "This ID was already used with different input" },
    });
    const read = vi.spyOn(store, "read").mockImplementation(() => {
      throw new Error("internal detail with a credential");
    });
    const unknown = await client.callTool({
      name: "commission_read",
      arguments: { commissionId: "one" },
    });
    expect(unknown.structuredContent).toEqual({
      error: { code: "internal", message: "Commissioning operation failed" },
    });
    expect(JSON.stringify(unknown)).not.toContain("credential");
    read.mockRestore();
    const report = vi.spyOn(store, "report");
    const moving = await client.callTool({
      name: "commission_report",
      arguments: {
        commissionId: "one",
        eventId: "branch",
        kind: "proposal",
        data: {
          summary: "Ready",
          artifact: {
            repository: "https://github.com/example/repo",
            commit: "main",
            pullRequest: "https://github.com/example/repo/pull/1",
          },
        },
      },
    });
    // A malformed artifact is the handler's refusal, with the store's reason, not a protocol error from the SDK.
    expect(moving.isError).toBe(true);
    expect(moving.structuredContent).toMatchObject({ error: { code: "invalid_input" } });
    // The per-kind rules hold in the handler: a proposal needs its artifact, and only a proposal may carry one.
    const artifact = {
      repository: "https://github.com/example/repo",
      commit: "c".repeat(40),
      pullRequest: "https://github.com/example/repo/pull/1",
    };
    for (const args of [
      { commissionId: "one", eventId: "bare", kind: "proposal", data: { summary: "Ready" } },
      {
        commissionId: "one",
        eventId: "extra",
        kind: "checkpoint",
        data: { summary: "Busy", artifact },
      },
    ])
      expect(await call(client, "commission_report", args), args.eventId).toMatchObject({
        error: { code: "invalid_input" },
      });
    expect(report).not.toHaveBeenCalled();
  });
});
