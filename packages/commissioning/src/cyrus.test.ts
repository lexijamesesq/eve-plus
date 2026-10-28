import { generateKeyPairSync } from "node:crypto";
import { importSPKI, jwtVerify } from "jose";
import { describe, expect, it, vi } from "vitest";
import { createSignedWorkerCredential } from "./auth.js";
import type { CyrusOptions } from "./cyrus.js";
import {
  CyrusConnectorError,
  createCyrusWorkerArtifacts,
  cyrus,
  runCyrusHeadersHelper,
} from "./cyrus.js";
import { createDispatcher } from "./dispatch.js";
import { openSchema } from "./schemas.js";
import { CommissionStore } from "./store.js";

const canonicalId = "54a5af43-b771-4ca3-ae89-072150369d45";
const issueUrl = "https://linear.app/example/issue/ENG-123/demo";
const delegateId = "9bb30997-76fe-43bb-812f-6042ad791543";
const mcp = { serverName: "commissioner", endpoint: "https://agent.example/commissioning/mcp" };
const spec = { brief: "Build the requested change", acceptance: ["The check passes"] };
const commissionId = "commission-one";

const selects = (query: string, field: string) =>
  query.match(/\{\s*(issue|commentCreate|issueUpdate)\s*\(/)?.[1] === field;

function provider() {
  const issue = {
    id: canonicalId,
    url: issueUrl,
    description: "## Objective\nKeep this objective\n\n## Done When\nKeep these criteria",
    delegate: null as null | { id: string },
  };
  const comments: { id: string; body: string }[] = [];
  const journal: { query: string; variables: Record<string, string> }[] = [];
  const fault = {
    beforeComment: false,
    afterComment: false,
    beforeDelegate: false,
    afterDelegate: false,
    readbackUnavailable: false,
    partialComment: false,
    partialDelegate: false,
    nextReadUnavailable: false,
    extraPage: false,
    humanDescriptionEdit: "",
  };
  const requestFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    expect(request.url).toBe("https://api.linear.app/graphql");
    expect(request.method).toBe("POST");
    expect(request.headers.get("authorization")).toBe("Bearer synthetic-linear-secret");
    const body = (await request.json()) as { query: string; variables: Record<string, string> };
    // Exercise the actual GraphQL wire boundary, including the old description-writing implementation.
    journal.push(structuredClone(body));
    if (selects(body.query, "issue")) {
      if (fault.nextReadUnavailable) {
        fault.nextReadUnavailable = false;
        return new Response("provider-credential-must-not-escape", { status: 503 });
      }
      expect(["ENG-123", canonicalId]).toContain(body.variables.id);
      const matches = comments.filter(
        (comment) =>
          comment.id === body.variables.commentId || comment.body.includes("<!-- eve-commission:"),
      );
      return Response.json({
        data: {
          issue: {
            ...structuredClone(issue),
            comments: {
              nodes: structuredClone(matches.slice(0, 2)),
              pageInfo: { hasNextPage: fault.extraPage || matches.length > 2 },
            },
          },
        },
      });
    }
    if (selects(body.query, "commentCreate")) {
      expect(body.variables.issueId).toBe(canonicalId);
      if (fault.beforeComment) {
        fault.beforeComment = false;
        throw new Error("synthetic failure before comment");
      }
      expect(comments.some((comment) => comment.id === body.variables.commentId)).toBe(false);
      comments.push({
        id: body.variables.commentId,
        body: fault.partialComment ? "Changed contract" : body.variables.body,
      });
      if (fault.readbackUnavailable) {
        fault.nextReadUnavailable = true;
        fault.readbackUnavailable = false;
      }
      if (fault.afterComment) {
        fault.afterComment = false;
        throw new Error("synthetic response lost after comment");
      }
      return Response.json({ data: { commentCreate: { success: true } } });
    }
    expect(selects(body.query, "issueUpdate")).toBe(true);
    expect(body.variables.id).toBe(canonicalId);
    if (fault.beforeDelegate) {
      fault.beforeDelegate = false;
      throw new Error("synthetic failure before delegation");
    }
    if (fault.humanDescriptionEdit) issue.description = fault.humanDescriptionEdit;
    // Preserve support for the prior valid wire request so race regressions fail on lost edits, not mocks.
    if (Object.hasOwn(body.variables, "description"))
      issue.description = body.variables.description;
    if (!fault.partialDelegate) issue.delegate = { id: body.variables.delegateId };
    if (fault.afterDelegate) {
      fault.afterDelegate = false;
      throw new Error("synthetic response lost after delegation");
    }
    return Response.json({ data: { issueUpdate: { success: true } } });
  };
  const options: CyrusOptions = {
    linear: { accessToken: () => "synthetic-linear-secret", fetch: requestFetch },
    delegateId,
    mcp,
  };
  const connector = cyrus(options);
  const prepare = () =>
    connector.prepare({ commissionId, reference: { kind: "linear-issue", id: "ENG-123" } });
  const mutations = () =>
    journal.filter(
      (entry) => selects(entry.query, "commentCreate") || selects(entry.query, "issueUpdate"),
    );
  const commentWrites = () => mutations().filter((entry) => selects(entry.query, "commentCreate"));
  const delegations = () => mutations().filter((entry) => selects(entry.query, "issueUpdate"));
  return {
    connector,
    prepare,
    issue,
    comments,
    journal,
    fault,
    options,
    mutations,
    commentWrites,
    delegations,
  };
}

describe("public Cyrus Linear connector", () => {
  it("prepares a read-only comment identity, appends its contract and delegates without replacing work", async () => {
    const fixture = provider();
    const originalDescription = fixture.issue.description;
    const binding = await fixture.prepare();
    expect(fixture.mutations()).toHaveLength(0);
    expect(binding).toEqual({
      version: "2",
      commissionId,
      issueId: canonicalId,
      issueUrl,
      delegateId,
      mcpServerName: mcp.serverName,
      mcpEndpoint: mcp.endpoint,
      contractCommentId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
    });
    await fixture.connector.handoff({ commissionId, spec, binding });
    expect(fixture.issue.description).toBe(originalDescription);
    expect(fixture.comments).toEqual([
      {
        id: binding.contractCommentId,
        body: expect.stringContaining(`Commission ID: ${commissionId}`),
      },
    ]);
    const contract = fixture.comments[0].body;
    for (const value of [
      spec.brief,
      `- ${spec.acceptance[0]}`,
      `MCP server: ${mcp.serverName}`,
      `Endpoint: ${mcp.endpoint}`,
    ])
      expect(contract).toContain(value);
    expect(fixture.issue.delegate).toEqual({ id: delegateId });
    expect(fixture.commentWrites()).toHaveLength(1);
    expect(fixture.delegations()).toHaveLength(1);
    await fixture.connector.handoff({ commissionId, spec, binding });
    expect(fixture.commentWrites()).toHaveLength(1);
    expect(fixture.delegations()).toHaveLength(1);
  });

  it("rejects a native-valid oversized rendered contract before any handoff request", async () => {
    const fixture = provider();
    const binding = await fixture.prepare();
    const large = {
      brief: "Work",
      acceptance: Array.from({ length: 33 }, () => "x".repeat(32768)),
    };
    expect(openSchema.safeParse({ spec: large }).success).toBe(true);
    const requestsBefore = fixture.journal.length;
    await expect(fixture.connector.handoff({ commissionId, spec: large, binding })).rejects.toEqual(
      new CyrusConnectorError("contract_too_large"),
    );
    expect(fixture.journal).toHaveLength(requestsBefore);
    expect(fixture.comments).toHaveLength(0);
    expect(fixture.issue.delegate).toBeNull();
  });

  it("hands off a native-valid large contract below the local rendered limit", async () => {
    const fixture = provider();
    const binding = await fixture.prepare();
    const large = {
      brief: "Work",
      acceptance: Array.from({ length: 31 }, () => "x".repeat(32768)),
    };
    expect(openSchema.safeParse({ spec: large }).success).toBe(true);
    await fixture.connector.handoff({ commissionId, spec: large, binding });
    expect(fixture.comments[0].body.length).toBeGreaterThan(1_000_000);
    expect(fixture.comments[0].body.length).toBeLessThanOrEqual(1_048_576);
    expect(fixture.commentWrites()).toHaveLength(1);
    expect(fixture.delegations()).toHaveLength(1);
    expect(fixture.issue.delegate).toEqual({ id: delegateId });
  });

  it("preserves a human work-description edit at the actual delegation boundary", async () => {
    const fixture = provider();
    const binding = await fixture.prepare();
    fixture.fault.humanDescriptionEdit = `${fixture.issue.description}\nCritical new human acceptance criterion`;
    await fixture.connector.handoff({ commissionId, spec, binding });
    expect(fixture.issue.description).toBe(fixture.fault.humanDescriptionEdit);
    expect(fixture.delegations()[0].variables).toEqual({ id: canonicalId, delegateId });
  });

  it.each(["afterComment", "afterDelegate"] as const)(
    "reconciles committed %s response loss without repeating its write",
    async (kind) => {
      const fixture = provider();
      const binding = await fixture.prepare();
      fixture.fault[kind] = true;
      await expect(
        fixture.connector.handoff({ commissionId, spec, binding }),
      ).rejects.toMatchObject({ code: "provider_unavailable" });
      if (kind === "afterComment") expect(fixture.issue.delegate).toBeNull();
      await fixture.connector.handoff({ commissionId, spec, binding });
      expect(fixture.commentWrites()).toHaveLength(1);
      expect(fixture.delegations()).toHaveLength(1);
    },
  );

  it.each([false, true])(
    "acknowledges marker-bearing task text without duplicate contract (lost delegation response: %s)",
    async (loseResponse) => {
      const fixture = provider();
      const binding = await fixture.prepare();
      const markerSpec = {
        brief: `Document <!-- eve-commission: and <!-- eve-commission:${commissionId} --> exactly.`,
        acceptance: [`Quote <!-- /eve-commission:${commissionId} -->.`],
      };
      const owner = { verified: true as const, principalId: "owner" };
      const worker = { verified: true as const, principalId: "worker" };
      const store = new CommissionStore(":memory:");
      try {
        store.open(
          owner,
          {
            commissionId,
            spec: markerSpec,
            workReference: { kind: "linear-issue", id: "ENG-123" },
          },
          worker,
          { originSessionId: "original", messages: [] },
          {
            workerBinding: {
              commissionId,
              connectorId: fixture.connector.id,
              reference: { kind: "linear-issue", id: "ENG-123" },
              binding,
            },
          },
        );
        const drain = createDispatcher(store, {
          dataDir: "/tmp/cyrus-regression",
          namespace: "marker-regression",
          workerPrincipalId: "worker",
          authenticateWorker: () => null,
          resolveSessionPrincipal: () => null,
          resolveDeliveryAuth: () => null,
          worker: fixture.connector,
        });
        const unexpected = vi.fn(async () => {
          throw Error("Owner path must not activate");
        });
        fixture.fault.afterDelegate = loseResponse;
        await drain(unexpected);
        if (loseResponse) {
          expect(store.read(owner, commissionId).notification?.pending).toBe(1);
          await drain(unexpected);
        }
        expect(store.read(owner, commissionId).notification).toMatchObject({
          pending: 0,
          attemptCount: loseResponse ? 2 : 1,
          failureClass: null,
        });
        expect(unexpected).not.toHaveBeenCalled();
        expect(fixture.comments).toHaveLength(1);
        expect(fixture.commentWrites()).toHaveLength(1);
        expect(fixture.delegations()).toHaveLength(1);
        expect(fixture.comments[0].body).toContain(markerSpec.brief);
        expect(fixture.comments[0].body).toContain(markerSpec.acceptance[0]);
      } finally {
        store.close();
      }
    },
  );

  it("does not delegate before exact comment readback and preserves a failed or edited comment", async () => {
    const fixture = provider();
    const binding = await fixture.prepare();
    fixture.fault.partialComment = true;
    await expect(fixture.connector.handoff({ commissionId, spec, binding })).rejects.toMatchObject({
      code: "handoff_unconfirmed",
    });
    expect(fixture.delegations()).toHaveLength(0);
    await expect(fixture.connector.handoff({ commissionId, spec, binding })).rejects.toMatchObject({
      code: "handoff_conflict",
    });
    expect(fixture.commentWrites()).toHaveLength(1);
  });

  it("leaves an unavailable comment readback pending and reconciles without rewriting", async () => {
    const fixture = provider();
    const binding = await fixture.prepare();
    fixture.fault.readbackUnavailable = true;
    await expect(fixture.connector.handoff({ commissionId, spec, binding })).rejects.toMatchObject({
      code: "provider_unavailable",
    });
    expect(fixture.delegations()).toHaveLength(0);
    await fixture.connector.handoff({ commissionId, spec, binding });
    expect(fixture.commentWrites()).toHaveLength(1);
    expect(fixture.delegations()).toHaveLength(1);
  });

  it.each(["beforeComment", "beforeDelegate"] as const)(
    "retries a safe pre-write %s failure",
    async (kind) => {
      const fixture = provider();
      const binding = await fixture.prepare();
      fixture.fault[kind] = true;
      await expect(
        fixture.connector.handoff({ commissionId, spec, binding }),
      ).rejects.toMatchObject({ code: "provider_unavailable" });
      await fixture.connector.handoff({ commissionId, spec, binding });
      expect(fixture.comments).toHaveLength(1);
      expect(fixture.issue.delegate).toEqual({ id: delegateId });
      expect(fixture.commentWrites()).toHaveLength(kind === "beforeComment" ? 2 : 1);
      expect(fixture.delegations()).toHaveLength(kind === "beforeDelegate" ? 2 : 1);
    },
  );

  it("does not acknowledge a provider that failed to apply delegation", async () => {
    const fixture = provider();
    const binding = await fixture.prepare();
    fixture.fault.partialDelegate = true;
    await expect(fixture.connector.handoff({ commissionId, spec, binding })).rejects.toMatchObject({
      code: "handoff_unconfirmed",
    });
    fixture.fault.partialDelegate = false;
    await fixture.connector.handoff({ commissionId, spec, binding });
    expect(fixture.commentWrites()).toHaveLength(1);
    expect(fixture.delegations()).toHaveLength(2);
  });

  it.each([
    "another-delegate",
    "same-delegate-without-contract",
    "legacy-description",
    "foreign-comment",
    "changed-contract",
    "extra-contract",
    "deleted-contract",
    "extra-page",
  ])("preserves conflicting external state: %s", async (kind) => {
    const fixture = provider();
    const binding = await fixture.prepare();
    if (kind === "another-delegate") fixture.issue.delegate = { id: "another-worker" };
    if (kind === "same-delegate-without-contract") fixture.issue.delegate = { id: delegateId };
    if (kind === "legacy-description") fixture.issue.description += "\n<!-- eve-commission:old -->";
    if (kind === "foreign-comment")
      fixture.comments.push({ id: "other-comment", body: "<!-- eve-commission:foreign -->" });
    if (["changed-contract", "extra-contract", "deleted-contract"].includes(kind)) {
      await fixture.connector.handoff({ commissionId, spec, binding });
      if (kind === "changed-contract")
        fixture.comments[0].body = "Changed entirely, including marker removal";
      else if (kind === "extra-contract")
        fixture.comments.push({ id: "other-comment", body: "<!-- eve-commission:foreign -->" });
      else fixture.comments.splice(0);
    }
    if (kind === "extra-page") fixture.fault.extraPage = true;
    const before = structuredClone({ issue: fixture.issue, comments: fixture.comments });
    const writes = fixture.mutations().length;
    await expect(fixture.connector.handoff({ commissionId, spec, binding })).rejects.toMatchObject({
      code: "handoff_conflict",
    });
    expect({ issue: fixture.issue, comments: fixture.comments }).toEqual(before);
    expect(fixture.mutations()).toHaveLength(writes);
  });

  it("refuses occupied work and wrong references during read-only preparation", async () => {
    const fixture = provider();
    fixture.comments.push({ id: "foreign", body: "<!-- eve-commission:other -->" });
    await expect(fixture.prepare()).rejects.toMatchObject({ code: "handoff_conflict" });
    expect(fixture.mutations()).toHaveLength(0);
    fixture.comments.splice(0);
    fixture.issue.delegate = { id: delegateId };
    await expect(fixture.prepare()).rejects.toMatchObject({ code: "handoff_conflict" });
    await expect(
      fixture.connector.prepare({ commissionId, reference: { kind: "other", id: "ENG-123" } }),
    ).rejects.toMatchObject({ code: "invalid_reference" });
  });

  it.each(["delegate", "endpoint", "server"])(
    "rejects configured %s drift before provider access",
    async (field) => {
      const fixture = provider();
      const binding = await fixture.prepare();
      const changed = cyrus({
        ...fixture.options,
        delegateId: field === "delegate" ? "new-worker" : delegateId,
        mcp: {
          serverName: field === "server" ? "another" : mcp.serverName,
          endpoint: field === "endpoint" ? "https://other.example/mcp" : mcp.endpoint,
        },
      });
      await expect(changed.handoff({ commissionId, spec, binding })).rejects.toMatchObject({
        code: "configuration_changed",
      });
      expect(fixture.journal).toHaveLength(1);
    },
  );

  it("rejects old binding version, malformed comment identity and canonical target drift", async () => {
    const fixture = provider();
    const binding = await fixture.prepare();
    for (const changed of [
      { ...binding, version: "1" },
      { ...binding, contractCommentId: "not-a-uuid" },
      { ...binding, commissionId: "other" },
      { ...binding, secret: "forbidden" },
    ])
      await expect(
        fixture.connector.handoff({ commissionId, spec, binding: changed }),
      ).rejects.toMatchObject({ code: "invalid_binding" });
    expect(fixture.journal).toHaveLength(1);
    fixture.issue.url = "https://linear.app/other/issue/ENG-123/changed";
    await expect(fixture.connector.handoff({ commissionId, spec, binding })).rejects.toMatchObject({
      code: "handoff_conflict",
    });
    expect(fixture.mutations()).toHaveLength(0);
  });

  it("never serializes private host fields or raw provider errors into the contract", async () => {
    const fixture = provider();
    const binding = await fixture.prepare();
    const wider = {
      ...spec,
      privateGuidance: "PRIVATE_GUIDANCE",
      history: "PRIVATE_HISTORY",
      source: "PRIVATE_SOURCE",
    };
    await fixture.connector.handoff({ commissionId, spec: wider, binding });
    expect(JSON.stringify({ binding, journal: fixture.journal })).not.toMatch(
      /PRIVATE_GUIDANCE|PRIVATE_HISTORY|PRIVATE_SOURCE|synthetic-linear-secret/,
    );
    const broken = cyrus({
      ...fixture.options,
      linear: {
        accessToken: () => {
          throw Error("PRIVATE_PROVIDER_CREDENTIAL");
        },
        fetch: fixture.options.linear.fetch,
      },
    });
    await expect(
      broken.prepare({ commissionId, reference: { kind: "linear-issue", id: "ENG-123" } }),
    ).rejects.toEqual(new CyrusConnectorError("provider_unavailable"));
  });

  it("rejects malformed canonical records safely", async () => {
    for (const issue of [
      null,
      { id: canonicalId },
      { id: canonicalId, url: "https://evil.example/issue", description: null, delegate: null },
    ]) {
      const connector = cyrus({
        ...provider().options,
        linear: { accessToken: "synthetic", fetch: async () => Response.json({ data: { issue } }) },
      });
      await expect(
        connector.prepare({ commissionId, reference: { kind: "linear-issue", id: "ENG-123" } }),
      ).rejects.toEqual(new CyrusConnectorError("work_unavailable"));
    }
  });

  it("bounds token resolution and preserves cancellation in the actual fetch signal", async () => {
    let resolveToken: (value: string) => void = () => {};
    const requestFetch = vi.fn<typeof fetch>();
    const timed = cyrus({
      ...provider().options,
      timeoutMs: 10,
      linear: {
        accessToken: () =>
          new Promise<string>((resolve) => {
            resolveToken = resolve;
          }),
        fetch: requestFetch,
      },
    });
    await expect(
      timed.prepare({ commissionId, reference: { kind: "linear-issue", id: "ENG-123" } }),
    ).rejects.toEqual(new CyrusConnectorError("timeout"));
    resolveToken("late-credential");
    await Promise.resolve();
    expect(requestFetch).not.toHaveBeenCalled();
    const controller = new AbortController();
    let actualSignal: AbortSignal | undefined;
    const cancelled = cyrus({
      ...provider().options,
      linear: {
        accessToken: "synthetic",
        signal: controller.signal,
        fetch: async (_input, init) => {
          actualSignal = init?.signal ?? undefined;
          controller.abort();
          return new Promise<Response>(() => {});
        },
      },
    });
    await expect(
      cancelled.prepare({ commissionId, reference: { kind: "linear-issue", id: "ENG-123" } }),
    ).rejects.toEqual(new CyrusConnectorError("cancelled"));
    expect(actualSignal?.aborted).toBe(true);
  });
});

const servers = { commissioner: mcp.endpoint };
function helperOutput() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    streams: {
      stdout: {
        write: (value: string | Uint8Array) => {
          stdout.push(String(value));
          return true;
        },
      },
      stderr: {
        write: (value: string | Uint8Array) => {
          stderr.push(String(value));
          return true;
        },
      },
    },
  };
}

describe("public native Cyrus worker artifacts and helper", () => {
  it("generates native HTTP configuration, exact three permissions, and usable worker protocol", () => {
    const assets = createCyrusWorkerArtifacts({
      servers: { commissioner: mcp.endpoint, other: "http://127.0.0.1:43123/mcp" },
      headersHelperPath: "/tmp/example/headers-helper",
    });
    expect(assets.mcpConfig).toEqual({
      mcpServers: {
        commissioner: {
          type: "http",
          url: mcp.endpoint,
          headersHelper: "/tmp/example/headers-helper",
        },
        other: {
          type: "http",
          url: "http://127.0.0.1:43123/mcp",
          headersHelper: "/tmp/example/headers-helper",
        },
      },
    });
    expect(new Set(assets.allowedTools)).toEqual(
      new Set(
        ["commissioner", "other"].flatMap((server) =>
          ["commission_read", "commission_consult", "commission_report"].map(
            (tool) => `mcp__${server}__${tool}`,
          ),
        ),
      ),
    );
    expect(assets.instructions).toContain("mcp__commissioner__commission_consult");
    expect(assets.instructions).not.toContain("mcp__commissioner__commission_decide");
  });

  it.each<Parameters<typeof createCyrusWorkerArtifacts>[0]>([
    { servers: {}, headersHelperPath: "/tmp/helper" },
    { servers: { "bad name": mcp.endpoint }, headersHelperPath: "/tmp/helper" },
    { servers: { commissioner: "http://remote.example/mcp" }, headersHelperPath: "/tmp/helper" },
    {
      servers: { commissioner: "https://secret@agent.example/mcp" },
      headersHelperPath: "/tmp/helper",
    },
    {
      servers: { commissioner: "https://agent.example/mcp?token=secret" },
      headersHelperPath: "/tmp/helper",
    },
    { servers, headersHelperPath: "./relative-helper" },
  ])("rejects invalid generated configuration without reflecting values", (options) => {
    expect(() => createCyrusWorkerArtifacts(options)).toThrow(
      "Invalid Cyrus connector configuration",
    );
  });

  it("emits only SDK header JSON after exact owned destination validation", async () => {
    const output = helperOutput();
    const resolver = vi.fn(() => "synthetic-worker-secret");
    expect(
      await runCyrusHeadersHelper({
        servers,
        resolveCredential: resolver,
        ...output.streams,
        env: {
          CLAUDE_CODE_MCP_SERVER_NAME: "commissioner",
          CLAUDE_CODE_MCP_SERVER_URL: mcp.endpoint,
        },
      }),
    ).toBe(0);
    expect(resolver).toHaveBeenCalledOnce();
    expect(resolver.mock.calls[0]).toMatchObject([
      { serverName: "commissioner", endpoint: mcp.endpoint },
    ]);
    expect(JSON.parse(output.stdout.join(""))).toEqual({
      Authorization: "Bearer synthetic-worker-secret",
    });
    expect(output.stderr).toEqual([]);
  });

  it("uses the opt-in signer through the native helper with exact audience and configurable expiry", async () => {
    const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicKey = await importSPKI(
      keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      "ES256",
    );
    const output = helperOutput();
    const signer = createSignedWorkerCredential({
      issuer: "urn:example:worker",
      subject: "worker",
      lifetimeSeconds: 45,
      resolvePrivateKey: ({ signal }) => {
        signal.throwIfAborted();
        return pem;
      },
    });
    expect(
      await runCyrusHeadersHelper({
        servers,
        resolveCredential: signer,
        ...output.streams,
        env: {
          CLAUDE_CODE_MCP_SERVER_NAME: "commissioner",
          CLAUDE_CODE_MCP_SERVER_URL: mcp.endpoint,
        },
      }),
    ).toBe(0);
    const header = JSON.parse(output.stdout.join("")).Authorization as string;
    const { payload } = await jwtVerify(header.slice("Bearer ".length), publicKey, {
      algorithms: ["ES256"],
      issuer: "urn:example:worker",
      subject: "worker",
      audience: mcp.endpoint,
    });
    if (typeof payload.exp !== "number" || typeof payload.iat !== "number")
      throw new Error("Missing token lifetime");
    expect(payload.exp - payload.iat).toBe(45);
    expect(output.stderr).toEqual([]);
    expect(output.stdout.join("")).not.toContain("PRIVATE KEY");
  });

  it("hides signing key failures through both the public signer and native helper", async () => {
    const output = helperOutput();
    const signer = createSignedWorkerCredential({
      issuer: "urn:example:worker",
      subject: "worker",
      resolvePrivateKey: () => "PRIVATE_KEY_CANARY",
    });
    await expect(
      signer({ endpoint: mcp.endpoint, signal: new AbortController().signal }),
    ).rejects.toEqual(new Error("Signed worker credential unavailable"));
    expect(
      await runCyrusHeadersHelper({
        servers,
        resolveCredential: signer,
        ...output.streams,
        env: {
          CLAUDE_CODE_MCP_SERVER_NAME: "commissioner",
          CLAUDE_CODE_MCP_SERVER_URL: mcp.endpoint,
        },
      }),
    ).toBe(1);
    expect(output.stdout).toEqual([]);
    expect(output.stderr).toEqual(["Commissioning authentication unavailable\n"]);
  });

  it.each([
    {},
    { CLAUDE_CODE_MCP_SERVER_NAME: "other", CLAUDE_CODE_MCP_SERVER_URL: mcp.endpoint },
    {
      CLAUDE_CODE_MCP_SERVER_NAME: "commissioner",
      CLAUDE_CODE_MCP_SERVER_URL: "https://other.example/mcp",
    },
    { CLAUDE_CODE_MCP_SERVER_NAME: "commissioner", CLAUDE_CODE_MCP_SERVER_URL: `${mcp.endpoint}/` },
  ])("never resolves credentials for missing or mismatched SDK context", async (env) => {
    const output = helperOutput();
    const resolver = vi.fn(() => "secret-must-not-escape");
    expect(
      await runCyrusHeadersHelper({ servers, env, resolveCredential: resolver, ...output.streams }),
    ).toBe(1);
    expect(resolver).not.toHaveBeenCalled();
    expect(output.stdout).toEqual([]);
    expect(output.stderr).toEqual(["Commissioning authentication unavailable\n"]);
  });

  it.each(["", "worker\nsecret", "worker secret", "x".repeat(4097)])(
    "rejects invalid credentials through fixed errors without stdout",
    async (credential) => {
      const output = helperOutput();
      expect(
        await runCyrusHeadersHelper({
          servers,
          ...output.streams,
          env: {
            CLAUDE_CODE_MCP_SERVER_NAME: "commissioner",
            CLAUDE_CODE_MCP_SERVER_URL: mcp.endpoint,
          },
          resolveCredential: () => credential,
        }),
      ).toBe(1);
      expect(output.stdout).toEqual([]);
      expect(output.stderr).toEqual(["Commissioning authentication unavailable\n"]);
    },
  );

  it("hides provider exceptions and bounds header resolution below the native deadline", async () => {
    const env = {
      CLAUDE_CODE_MCP_SERVER_NAME: "commissioner",
      CLAUDE_CODE_MCP_SERVER_URL: mcp.endpoint,
    };
    const failed = helperOutput();
    expect(
      await runCyrusHeadersHelper({
        servers,
        env,
        ...failed.streams,
        resolveCredential: () => {
          throw new Error("secret-provider-detail");
        },
      }),
    ).toBe(1);
    expect(failed.stderr).toEqual(["Commissioning authentication unavailable\n"]);
    const timed = helperOutput();
    let actualSignal: AbortSignal | undefined;
    expect(
      await runCyrusHeadersHelper({
        servers,
        env,
        ...timed.streams,
        timeoutMs: 10,
        resolveCredential: ({ signal }) => {
          actualSignal = signal;
          return new Promise<string>(() => {});
        },
      }),
    ).toBe(1);
    expect(actualSignal?.aborted).toBe(true);
    expect(timed.stdout).toEqual([]);
    expect(timed.stderr).toEqual(["Commissioning authentication unavailable\n"]);
  });
});
