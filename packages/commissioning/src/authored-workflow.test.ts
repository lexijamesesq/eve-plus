import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CommissioningConfig } from "./config.js";
import { createDispatcher } from "./dispatch.js";
import { CommissionStore } from "./store.js";
import type { CommissionView, MutationResult } from "./types.js";

const host = vi.hoisted(() => ({
  state: { commissionIds: [] as string[] },
  config: {} as CommissioningConfig,
  store: undefined as CommissionStore | undefined,
  drain: undefined as ReturnType<typeof createDispatcher> | undefined,
}));
vi.mock("eve/tools", () => ({ defineTool: (definition: unknown) => definition }));
vi.mock("eve/channels", () => ({
  defineChannel: (definition: unknown) => definition,
  POST: (path: string, handle: unknown) => ({ path, handle }),
  GET: (path: string, handle: unknown) => ({ path, handle }),
  DELETE: (path: string, handle: unknown) => ({ path, handle }),
}));
vi.mock("eve/schedules", () => ({ defineSchedule: (definition: unknown) => definition }));
vi.mock("eve/context", () => ({
  defineState: () => ({
    get: () => host.state,
    update: (update: (state: typeof host.state) => typeof host.state) => {
      host.state = update(host.state);
    },
  }),
}));
vi.mock("../extension/extension.js", () => ({
  default: {
    get config() {
      return host.config;
    },
  },
}));
vi.mock("../extension/lib/runtime.js", () => ({
  runtime: () => ({ store: host.store, drain: host.drain }),
}));

import authoredChannel, { deliverOwner } from "../extension/channels/commissioning.js";
import authoredSchedule from "../extension/schedules/reconcile.js";
import authoredDecide from "../extension/tools/decide.js";
import authoredOpen from "../extension/tools/open.js";
import authoredRead from "../extension/tools/read.js";

type Context = Parameters<NonNullable<typeof authoredOpen.execute>>[1];
const openTool = authoredOpen.execute;
const readTool = authoredRead.execute;
const decideTool = authoredDecide.execute;
if (!openTool || !readTool || !decideTool) throw new Error("Expected authored executable tools");
function store() {
  if (!host.store) throw new Error("Test store is not initialized");
  return host.store;
}
function drain() {
  if (!host.drain) throw new Error("Test dispatcher is not initialized");
  return host.drain;
}

const owner = { verified: true as const, principalId: "owner" };
const worker = { verified: true as const, principalId: "worker" };
const auth = { authenticator: "test", principalId: "owner", principalType: "user", attributes: {} };
const spec = {
  brief: "Build the feature",
  acceptance: ["An immutable artifact meets the criteria"],
  privateGuidance: "PRIVATE_GUIDANCE",
};
const reference = { kind: "linear-issue", id: "ENG-123" };
function context(
  id = "original",
  principalId = "owner",
  attributes: Record<string, string> = {},
): Context {
  return {
    session: {
      id,
      auth: {
        current: { ...auth, principalId, attributes },
        initiator: { ...auth, principalId: "actual-initiator" },
      },
      turn: { id: "turn", sequence: 1 },
    },
    callId: "call-1",
    messages: [
      { role: "system", content: "SYSTEM_SECRET" },
      {
        role: "user",
        content: [
          { type: "text", text: "ORIGINAL_CONTEXT" },
          { type: "image", image: "PRIVATE_IMAGE" },
        ],
      },
      { role: "assistant", content: "Recorded discussion" },
      { role: "tool", content: "TOOL_SECRET" },
    ],
  } as unknown as Context;
}
beforeEach(() => {
  host.state = { commissionIds: [] };
  host.config = {
    dataDir: "/tmp/unused-authored-test",
    namespace: "authored",
    workerPrincipalId: "worker",
    authenticateWorker: () => worker,
    resolveSessionPrincipal: (value) =>
      value?.authenticator === "test" ? { verified: true, principalId: value.principalId } : null,
    resolveDeliveryAuth: () => auth,
    captureSource: () => ({ conversationId: "PRIVATE_SOURCE" }),
  };
  host.store = new CommissionStore(":memory:");
  host.drain = createDispatcher(host.store, host.config);
});
afterEach(() => host.store?.close());

it("executes authored neutral open/read with native identity, textual context and stable retries", async () => {
  const receipt = (await openTool({ spec }, context())) as MutationResult;
  const { commissionId } = receipt;
  expect(store().context(commissionId)).toEqual({
    originSessionId: "original",
    messages: [
      { role: "user", content: "ORIGINAL_CONTEXT" },
      { role: "assistant", content: "Recorded discussion" },
    ],
    source: { conversationId: "PRIVATE_SOURCE" },
    initiator: { principalId: "actual-initiator", authenticator: "test", principalType: "user" },
  });
  expect(
    ((await readTool({ commissionId, after: 0 }, context())) as CommissionView).spec
      .privateGuidance,
  ).toBe("PRIVATE_GUIDANCE");
  expect(store().claimOutbox({ consumerId: "check" })).toEqual([]);
  expect(store().workerBinding(commissionId)).toBeUndefined();
  const workerProjection = JSON.stringify(store().read(worker, commissionId));
  for (const sentinel of [
    "PRIVATE_GUIDANCE",
    "ORIGINAL_CONTEXT",
    "PRIVATE_SOURCE",
    "actual-initiator",
  ])
    expect(workerProjection).not.toContain(sentinel);
  const later = { ...context(), messages: [{ role: "user", content: "Later turn" }] } as Context;
  expect(await openTool({ spec }, later)).toEqual(receipt);
  expect(JSON.stringify(store().context(commissionId))).not.toContain("Later turn");
  host.state = { commissionIds: [] }; // Eve state is per session; model an unrelated empty session.
  expect(() => readTool({ commissionId, after: 0 }, context("unrelated"))).toThrow("not bound");
  await expect(openTool({ spec }, context("worker-session", "worker"))).rejects.toThrow(
    "Commissioner identity",
  );
  store().rebindSession(
    owner,
    {
      commissionId,
      eventId: "explicit-recovery",
      expectedActiveSessionId: "original",
      activeSessionId: "replacement",
      source: { conversationId: "PRIVATE_SOURCE" },
    },
    owner,
  );
  expect(await openTool({ spec }, context())).toEqual(receipt);
  expect(store().context(commissionId)?.activeSessionId).toBe("replacement");
  expect(() => readTool({ commissionId, after: 0 }, context())).toThrow("different active session");
});

it("lets the verified stored owner continue in a policy-approved source without rebinding", async () => {
  const { commissionId } = (await openTool({ spec }, context())) as MutationResult;
  const originalContext = store().context(commissionId);
  store().consult(worker, { commissionId, questionId: "question", question: { text: "Which?" } });
  host.config.authorizeOwnerSession = ({ session, context: recorded }) =>
    session.auth.current?.attributes.conversationId === recorded.source?.conversationId;
  host.state = { commissionIds: [] };
  const replacement = context("replacement", "owner", { conversationId: "PRIVATE_SOURCE" });
  const otherSource = context("other-source", "owner", { conversationId: "OTHER_SOURCE" });
  const decision = {
    commissionId,
    eventId: "answer",
    target: "question" as const,
    questionId: "question",
    decision: { answer: "Proceed" },
  };
  expect(() => readTool({ commissionId, after: 0 }, otherSource)).toThrow("authorization required");
  await expect(decideTool(decision, otherSource)).rejects.toThrow("authorization required");
  expect(store().question(worker, commissionId, "question").status).toBe("pending");
  expect(
    (readTool({ commissionId, after: 0 }, replacement) as CommissionView).spec.privateGuidance,
  ).toBe("PRIVATE_GUIDANCE");
  await decideTool(decision, replacement);
  expect(store().question(worker, commissionId, "question")).toMatchObject({
    status: "answered",
    answer: decision.decision,
  });
  expect(store().context(commissionId)).toEqual(originalContext);
});

it("keeps worker exclusion and stored ownership even with a permissive session policy", async () => {
  const { commissionId } = (await openTool({ spec }, context())) as MutationResult;
  host.config.authorizeOwnerSession = () => true;
  const original = context("unknown");
  const unknownAuth = {
    ...original,
    session: { ...original.session, auth: { ...original.session.auth, current: null } },
  } as Context;
  // A formerly assigned worker remains excluded by stored ownership after configuration changes.
  host.config.workerPrincipalId = "new-worker";
  for (const caller of [
    context("foreign", "stranger"),
    context("old-worker", "worker"),
    context("new-worker", "new-worker"),
    unknownAuth,
  ]) {
    expect(() => readTool({ commissionId, after: 0 }, caller)).toThrow();
    await expect(
      decideTool(
        {
          commissionId,
          eventId: "denied",
          target: "question",
          questionId: "question",
          decision: { answer: "Never" },
        },
        caller,
      ),
    ).rejects.toThrow();
  }
  expect(
    (readTool({ commissionId, after: 0 }, context("replacement")) as CommissionView).owner,
  ).toBe("owner");
});

it.each([
  ["false", (): boolean => false],
  [
    "throw",
    (): boolean => {
      throw new Error("PRIVATE_POLICY_FAILURE");
    },
  ],
  ["truthy non-boolean", (): boolean => "true" as unknown as boolean],
] as const)(
  "denies a configured %s policy without falling back to original binding",
  async (_name, policy) => {
    const { commissionId } = (await openTool({ spec }, context())) as MutationResult;
    host.config.authorizeOwnerSession = policy;
    expect(() => readTool({ commissionId, after: 0 }, context())).toThrow(
      "Owner session authorization required",
    );
  },
);

it("denies policy authorization when no durable commissioning source was captured", async () => {
  host.config.captureSource = undefined;
  const { commissionId } = (await openTool({ spec }, context())) as MutationResult;
  host.config.authorizeOwnerSession = () => true;
  expect(() => readTool({ commissionId, after: 0 }, context())).toThrow(
    "Owner session authorization required",
  );
  store().open(owner, { commissionId: "without-context", spec }, worker);
  host.state = { commissionIds: ["without-context"] };
  expect(() => readTool({ commissionId: "without-context", after: 0 }, context())).toThrow(
    "Owner session authorization required",
  );
});

it("requires connector/reference together and leaves no partial commission after failed preparation", async () => {
  await expect(openTool({ spec, workReference: reference }, context())).rejects.toThrow(
    "configured worker",
  );
  let attemptedCommissionId = "";
  const prepare = vi.fn(async ({ commissionId }: { commissionId: string }) => {
    attemptedCommissionId = commissionId;
    throw new Error("SECRET_PROVIDER_FAILURE");
  });
  host.config.worker = { id: "example-connector", prepare, handoff: vi.fn() };
  await expect(openTool({ spec }, context())).rejects.toThrow("requires a work reference");
  await expect(openTool({ spec, workReference: reference }, context())).rejects.toThrow(
    "Worker preparation failed",
  );
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(() => store().read(owner, attemptedCommissionId)).toThrow("Commission not found");
  expect(store().claimOutbox({ consumerId: "check" })).toEqual([]);
});

it("reuses immutable prepared targets for native retries and refuses changed specification/reference/connector", async () => {
  const prepare = vi.fn(async () => ({ version: "1", target: "canonical-work" }));
  const handoff = vi.fn(async () => {});
  host.config.worker = { id: "example-connector", prepare, handoff };
  const first = (await openTool({ spec, workReference: reference }, context())) as MutationResult;
  const { commissionId } = first;
  expect(await openTool({ spec, workReference: reference }, context())).toEqual(first);
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(store().workerBinding(commissionId)).toMatchObject({
    commissionId,
    connectorId: "example-connector",
    reference,
  });
  for (const input of [
    { spec: { ...spec, brief: "Changed" }, workReference: reference },
    { spec, workReference: { ...reference, id: "ENG-999" } },
  ])
    await expect(openTool(input, context())).rejects.toThrow("different input");
  host.config.worker = { ...host.config.worker, id: "another-connector" };
  await expect(openTool({ spec, workReference: reference }, context())).rejects.toThrow(
    "cannot change",
  );
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(handoff).not.toHaveBeenCalled();
});

it("seeds continuation authority through the actual authored event before deciding an existing question", async () => {
  const { commissionId } = (await openTool({ spec }, context())) as MutationResult;
  store().consult(worker, {
    commissionId,
    questionId: "question",
    question: { text: "Which behavior?" },
  });
  const decision = {
    commissionId,
    eventId: "answer",
    target: "question" as const,
    questionId: "question",
    decision: { answer: "Use the acceptance criteria" },
  };
  host.state = { commissionIds: [] };
  await expect(decideTool(decision, context("unrelated"))).rejects.toThrow("not bound");
  expect(store().question(worker, commissionId, "question").status).toBe("pending");
  const channel = authoredChannel as unknown as {
    events: { "turn.started": (event: unknown, channel: unknown, ctx: Context) => void };
  };
  expect(() =>
    channel.events["turn.started"](
      {},
      { continuation: { token: commissionId } },
      context("continuation", "stranger"),
    ),
  ).toThrow();
  channel.events["turn.started"](
    {},
    { continuation: { token: commissionId } },
    context("continuation"),
  );
  await decideTool(decision, context("continuation"));
  expect(store().question(worker, commissionId, "question")).toMatchObject({
    status: "answered",
    answer: decision.decision,
  });
});

it("uses authored default delivery history, queue policy and stable keys on retries", async () => {
  const { commissionId } = (await openTool({ spec }, context())) as MutationResult;
  store().consult(worker, { commissionId, questionId: "q", question: { text: "Which?" } });
  const create = vi.fn(async (_options: unknown) => ({
    created: true,
    session: { id: "continuation" },
  }));
  const send = vi.fn(async (_message: string, _options: unknown) => {});
  const from = vi.fn(() => ({ create, send }));
  await drain()(async (delivery) => {
    await deliverOwner(from as unknown as Parameters<typeof deliverOwner>[0], delivery);
    await deliverOwner(from as unknown as Parameters<typeof deliverOwner>[0], delivery);
  });
  expect(from).toHaveBeenCalledWith(commissionId);
  expect(create.mock.calls[0]).toEqual([
    {
      auth,
      history: [
        { role: "user", text: "ORIGINAL_CONTEXT" },
        { role: "assistant", text: "Recorded discussion" },
      ],
    },
  ]);
  expect(send.mock.calls[0]).toEqual(send.mock.calls[1]);
  expect(send.mock.calls[0]?.[1]).toMatchObject({
    auth,
    turnPolicy: "queue",
    idempotencyKey: expect.any(String),
  });
});

it("runs the authored schedule through the actual dispatcher and default channel receiver", async () => {
  const { commissionId } = (await openTool({ spec }, context())) as MutationResult;
  store().consult(worker, { commissionId, questionId: "q", question: { text: "Which?" } });
  const create = vi.fn(async (_options: unknown) => ({
    created: true,
    session: { id: "continuation" },
  }));
  const send = vi.fn(async (_message: string, _options: unknown) => {});
  const channel = authoredChannel as unknown as {
    receive: (input: unknown, ctx: unknown) => Promise<unknown>;
  };
  const to = vi.fn((target: unknown, coordinates: unknown) => ({
    send: async (message: string, options: { auth: unknown }) => {
      expect(target).toBe(authoredChannel);
      await channel.receive(
        { target: coordinates, auth: options.auth, message },
        { from: () => ({ create, send }) },
      );
    },
  }));
  const schedule = authoredSchedule as unknown as {
    run: (ctx: { to: typeof to }) => Promise<void>;
  };
  await schedule.run({ to });
  expect(to).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]?.[1]).toMatchObject({ turnPolicy: "queue", auth });
  expect(store().read(owner, commissionId).notification?.pending).toBe(0);
  await schedule.run({ to });
  expect(to).toHaveBeenCalledTimes(1);
});

it.each(["route", "schedule"])(
  "fails closed on a wrong canonical recovery address and delivers after authenticated reset/create/rebind through %s",
  async (path) => {
    const { commissionId } = (await openTool({ spec }, context())) as MutationResult;
    store().rebindSession(
      owner,
      {
        commissionId,
        eventId: "recovery",
        expectedActiveSessionId: "original",
        activeSessionId: "unrelated",
        source: { conversationId: "PRIVATE_SOURCE" },
      },
      owner,
    );
    store().consult(worker, {
      commissionId,
      questionId: "recovered-question",
      question: { text: "Which?" },
    });
    let canonicalSession = "original";
    const create = vi.fn(async (_options: unknown) => ({
      created: false,
      session: { id: canonicalSession },
    }));
    const send = vi.fn(async (_message: string, _options: unknown) => {});
    const source = {
      create,
      send,
      reset: vi.fn(async () => {
        canonicalSession = "replacement";
      }),
    };
    const from = () => source;
    const channel = authoredChannel as unknown as {
      receive: (input: unknown, ctx: unknown) => Promise<unknown>;
      events: { "turn.started": (event: unknown, continuation: unknown, ctx: Context) => void };
    };
    const run = () =>
      path === "route"
        ? drain()((delivery) =>
            deliverOwner(from as unknown as Parameters<typeof deliverOwner>[0], delivery),
          )
        : (authoredSchedule as unknown as { run: (ctx: unknown) => Promise<void> }).run({
            to: (_target: unknown, target: unknown) => ({
              send: (message: string, options: { auth: unknown }) =>
                channel.receive({ target, auth: options.auth, message }, { from }),
            }),
          });
    await run();
    expect(send).not.toHaveBeenCalled();
    expect(store().read(owner, commissionId).notification).toMatchObject({
      pending: 1,
      failureClass: "dispatch_failed",
    });
    // The authorized host repairs the canonical address, rather than selecting an unrelated session.
    await source.reset();
    const { session } = await source.create({ auth });
    expect(session.id).toBe("replacement");
    store().rebindSession(
      owner,
      {
        commissionId,
        eventId: "canonical-recovery",
        expectedActiveSessionId: "unrelated",
        activeSessionId: session.id,
        source: { conversationId: "PRIVATE_SOURCE" },
      },
      owner,
    );
    await run();
    expect(send).toHaveBeenCalledOnce();
    expect(store().read(owner, commissionId).notification?.pending).toBe(0);
    channel.events["turn.started"](
      {},
      { continuation: { token: commissionId } },
      context("replacement"),
    );
    await decideTool(
      {
        commissionId,
        eventId: "recovered-answer",
        target: "question",
        questionId: "recovered-question",
        decision: { answer: "Authorized replacement answer" },
      },
      context("replacement"),
    );
    expect(store().question(worker, commissionId, "recovered-question").status).toBe("answered");
    expect(() => readTool({ commissionId, after: 0 }, context())).toThrow(
      "different active session",
    );
  },
);

it("returns the authored mutation response before held delivery while tracking eventual reconciliation with route waitUntil", async () => {
  const { commissionId } = (await openTool({ spec }, context())) as MutationResult;
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const originalDrain = drain();
  host.drain = (deliver) =>
    originalDrain(async (delivery) => {
      await held;
      return deliver(delivery);
    });
  const tracked: Promise<unknown>[] = [];
  const send = vi.fn(async (_message: string, _options: unknown) => {});
  const from = () => ({
    create: async () => ({ created: false, session: { id: "continuation" } }),
    send,
  });
  const route = (
    authoredChannel as unknown as {
      routes: { handle: (request: Request, ctx: unknown) => Promise<Response> }[];
    }
  ).routes[0];
  const client = new Client({ name: "authored-route-proof", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("https://fixture.invalid/commissioning/mcp"), {
      fetch: (url, init) =>
        route.handle(new Request(url, init), {
          from,
          waitUntil: (task: Promise<unknown>) => tracked.push(task),
        }),
    }),
  );
  const pending = client.callTool({
    name: "commission_consult",
    arguments: { commissionId, questionId: "background-question", question: { text: "Which?" } },
  });
  try {
    expect(
      await Promise.race([
        pending.then(() => "response"),
        new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 1000)),
      ]),
    ).toBe("response");
    expect(tracked).toHaveLength(1);
    expect(send).not.toHaveBeenCalled();
  } finally {
    release();
    await pending;
    await Promise.all(tracked);
    await client.close();
  }
  expect(send).toHaveBeenCalledOnce();
  expect(store().read(owner, commissionId).notification?.pending).toBe(0);
});
