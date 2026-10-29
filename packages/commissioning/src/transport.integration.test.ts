import { generateKeyPairSync } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { importPKCS8, type JWTPayload, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignedWorkerAuthenticator, createSignedWorkerCredential } from "./auth.js";
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
  credential = "fixture-secret",
) {
  const client = new Client({ name: "official-test-client", version: "1.0.0" });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL("https://fixture.invalid/commissioning/mcp"), {
      requestInit: { headers: { authorization: `Bearer ${credential}` } },
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

describe("optional signed worker authentication through the real MCP transport", () => {
  const issuer = "urn:example:worker";
  const audience = "https://fixture.invalid/commissioning/mcp";
  const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privatePem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  it("accepts signer credentials, keeps worker projection private, and denies expired credentials", async () => {
    const { store, config } = fixture();
    config.authenticateWorker = createSignedWorkerAuthenticator({
      issuer,
      subject: worker.principalId,
      audience,
      publicKeys: [publicKey],
      maxLifetimeSeconds: 45,
      clockToleranceSeconds: 0,
    });
    const signer = createSignedWorkerCredential({
      issuer,
      subject: worker.principalId,
      lifetimeSeconds: 45,
      resolvePrivateKey: () => privatePem,
    });
    const credential = await signer({ endpoint: audience, signal: new AbortController().signal });
    const client = await clientFor(store, config, undefined, credential);
    const read = await client.callTool({
      name: "commission_read",
      arguments: { commissionId: "one" },
    });
    expect(JSON.stringify(read)).not.toContain("Owner only");
    const consult = await client.callTool({
      name: "commission_consult",
      arguments: {
        commissionId: "one",
        questionId: "signed-question",
        question: { text: "Which label?" },
      },
    });
    expect(consult.isError).not.toBe(true);
    expect(store.read(owner, "one").questions).toMatchObject([{ questionId: "signed-question" }]);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 46_000);
      const response = await handleWorkerRequest(
        new Request(audience, {
          method: "POST",
          headers: { authorization: `Bearer ${credential}` },
        }),
        { store, config },
      );
      expect(response.status).toBe(401);
    } finally {
      vi.useRealTimers();
    }
  });

  it("admits expired and future-issued credentials within configured clock tolerance", async () => {
    const { store, config } = fixture();
    const key = await importPKCS8(privatePem, "ES256");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
      const now = Math.floor(Date.now() / 1000);
      for (const claims of [
        { iat: now - 100, exp: now - 20 },
        { iat: now + 20, exp: now + 100 },
      ]) {
        const credential = await new SignJWT({
          iss: issuer,
          sub: worker.principalId,
          aud: audience,
          ...claims,
        })
          .setProtectedHeader({ alg: "ES256" })
          .sign(key);
        for (const tolerance of [30, 0]) {
          config.authenticateWorker = createSignedWorkerAuthenticator({
            issuer,
            subject: worker.principalId,
            audience,
            publicKeys: [publicKey],
            maxLifetimeSeconds: 180,
            clockToleranceSeconds: tolerance,
          });
          const response = await handleWorkerRequest(
            new Request(audience, {
              method: "POST",
              headers: {
                authorization: `Bearer ${credential}`,
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
              },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: {
                  name: "commission_read",
                  arguments: { commissionId: "one" },
                },
              }),
            }),
            { store, config },
          );
          expect(response.status).toBe(tolerance === 30 ? 200 : 401);
          if (response.status === 200) {
            expect((await response.json()).result.structuredContent.result.commissionId).toBe(
              "one",
            );
          }
        }
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses invalid verification policy or trust during configuration", () => {
    const options = { issuer, subject: worker.principalId, audience, publicKeys: [publicKey] };
    for (const invalid of [
      { ...options, maxLifetimeSeconds: Number.NaN },
      { ...options, clockToleranceSeconds: -1 },
      { ...options, publicKeys: ["   "] },
    ]) {
      expect(() => createSignedWorkerAuthenticator(invalid)).toThrow(
        new Error("Invalid signed worker authentication configuration"),
      );
    }
  });

  it("rejects distinct signature, identity, destination and age-policy failures without mutation", async () => {
    const { store, config } = fixture();
    const maxLifetimeSeconds = 180;
    config.authenticateWorker = createSignedWorkerAuthenticator({
      issuer,
      subject: worker.principalId,
      audience,
      publicKeys: [publicKey],
      maxLifetimeSeconds,
    });
    const key = await importPKCS8(privatePem, "ES256");
    const now = Math.floor(Date.now() / 1000);
    const signed = (claims: JWTPayload = {}) =>
      new SignJWT({
        iss: issuer,
        sub: worker.principalId,
        aud: audience,
        iat: now,
        exp: now + maxLifetimeSeconds,
        ...claims,
      })
        .setProtectedHeader({ alg: "ES256" })
        .sign(key);
    const valid = await signed();
    const invalid = [
      ["signature", `${valid.slice(0, -12)}AAAAAAAAAAAA`],
      ["issuer", await signed({ iss: "urn:foreign" })],
      ["subject", await signed({ sub: "foreign-worker" })],
      ["destination", await signed({ aud: "https://other.example/mcp" })],
      ["missing-expiry", await signed({ exp: undefined })],
      ["missing-issued-at", await signed({ iat: undefined })],
      ["future-issued-at", await signed({ iat: now + 60 })],
      ["excessive-lifetime", await signed({ exp: now + maxLifetimeSeconds + 1 })],
      ["nonpositive-lifetime", await signed({ exp: now })],
    ];
    for (const [boundary, credential] of invalid) {
      const response = await handleWorkerRequest(
        new Request(audience, {
          method: "POST",
          headers: {
            authorization: `Bearer ${credential}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "commission_consult",
              arguments: {
                commissionId: "one",
                questionId: "denied",
                question: { text: "Not authorized" },
              },
            },
          }),
        }),
        { store, config },
      );
      expect(response.status, boundary).toBe(401);
    }
    expect(store.read(owner, "one").questions).toEqual([]);
  });

  it("denies empty trust, supports overlapping rotation and treats configured subjects literally", async () => {
    const key = await importPKCS8(privatePem, "ES256");
    const now = Math.floor(Date.now() / 1000);
    const credential = await new SignJWT({
      iss: issuer,
      sub: "worker:one",
      aud: audience,
      iat: now,
      exp: now + 300,
    })
      .setProtectedHeader({ alg: "ES256" })
      .sign(key);
    const request = new Request(audience, { headers: { authorization: `Bearer ${credential}` } });
    const otherKeys = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const otherPublic = otherKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const verify = (publicKeys: readonly string[], subject = "worker:one") =>
      createSignedWorkerAuthenticator({ issuer, subject, audience, publicKeys });
    expect(await verify([])(request)).toBeNull();
    expect(await verify([otherPublic, publicKey])(request)).toEqual({
      verified: true,
      principalId: "worker:one",
    });
    expect(await verify([otherPublic])(request)).toBeNull();
    expect(await verify([publicKey], "worker:*")(request)).toBeNull();
  });
});
