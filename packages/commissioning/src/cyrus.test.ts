import type { RouteHandlerArgs } from "eve/channels";
import { describe, expect, it, vi } from "vitest";
import type { CyrusOptions } from "./cyrus.js";
import { CyrusConnectorError, cyrus } from "./cyrus.js";
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
    expect(
      openSchema.safeParse({ spec: large, workReference: { kind: "linear-issue", id: "ENG-123" } })
        .success,
    ).toBe(true);
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
    expect(
      openSchema.safeParse({ spec: large, workReference: { kind: "linear-issue", id: "ENG-123" } })
        .success,
    ).toBe(true);
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
      const store = new CommissionStore(":memory:");
      try {
        store.open(
          { id: "felix", conversation: { thread: "1.0" } },
          {
            commissionId,
            spec: markerSpec,
            workReference: { kind: "linear-issue", id: "ENG-123" },
            connectorId: fixture.connector.id,
            binding,
          },
        );
        const unexpected = vi.fn(() => {
          throw Error("Only the handoff should run");
        });
        const drain = createDispatcher(store, {
          dataDir: "/unused",
          namespace: "marker-regression",
          worker: fixture.connector,
          authenticateWorker: () => false,
          commissioner: () => null,
          deliver: unexpected,
        });
        const to = unexpected as unknown as RouteHandlerArgs["to"];
        fixture.fault.afterDelegate = loseResponse;
        await drain(to);
        if (loseResponse) {
          expect(store.read(commissionId).handoff.status).toBe("pending");
          await drain(to);
        }
        expect(store.read(commissionId).handoff).toEqual({
          status: "confirmed",
          lastFailure: null,
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

  it("rejects a malformed comment identity and canonical target drift", async () => {
    const fixture = provider();
    const binding = await fixture.prepare();
    for (const changed of [
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

  it("keeps the Linear token and raw provider errors out of the binding, the requests' bodies and its errors", async () => {
    const fixture = provider();
    const binding = await fixture.prepare();
    await fixture.connector.handoff({ commissionId, spec, binding });
    expect(JSON.stringify({ binding, journal: fixture.journal })).not.toContain(
      "synthetic-linear-secret",
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

  it("refuses an endpoint that would put a credential or a remote plain-HTTP address in the contract", () => {
    const options = provider().options;
    for (const endpoint of [
      "https://worker:secret@agent.example/commissioning/mcp",
      "https://agent.example/commissioning/mcp?token=secret",
      "https://agent.example/commissioning/mcp#secret",
      "http://agent.example/commissioning/mcp",
    ])
      expect(() => cyrus({ ...options, mcp: { ...mcp, endpoint } }), endpoint).toThrow(
        new CyrusConnectorError("invalid_configuration"),
      );
    expect(() =>
      cyrus({ ...options, mcp: { ...mcp, endpoint: "http://127.0.0.1:3001/commissioning/mcp" } }),
    ).not.toThrow();
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
