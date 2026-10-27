import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CommissioningConfig } from "./config.js";
import { verified } from "./config.js";
import { consultSchema, readSchema, reportSchema } from "./schemas.js";
import { CommissionError, type CommissionStore } from "./store.js";
import type { Caller, ReportInput } from "./types.js";

export { createDispatcher, type OwnerDelivery } from "./dispatch.js";

export interface WorkerTransportOptions {
  store: CommissionStore;
  config: Pick<CommissioningConfig, "authenticateWorker" | "workerPrincipalId">;
  /** Reconcile only after durable mutation; failures leave delivery pending. */
  reconcile?: () => Promise<unknown>;
}

/** The worker has no owner operations, even when a credential is accidentally mapped to an owner. */
export async function handleWorkerRequest(
  request: Request,
  options: WorkerTransportOptions,
): Promise<Response> {
  let caller: Caller;
  try {
    caller = verified(await options.config.authenticateWorker(request));
    if (caller.principalId !== options.config.workerPrincipalId)
      throw new Error("Wrong worker mapping");
  } catch {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "www-authenticate": 'Bearer realm="commissioning"', "cache-control": "no-store" },
    });
  }
  const server = new McpServer({ name: "eve-plus-commissioning", version: "0.1.0" });
  const run = async (operation: () => unknown) => {
    try {
      const result = operation();
      if (options.reconcile) {
        try {
          await options.reconcile();
        } catch {
          /* Durable outbox retries later. */
        }
      }
      const body = { result, recorded: true };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(body) }],
        structuredContent: body,
      };
    } catch (error) {
      const code = error instanceof CommissionError ? error.code : "internal";
      // Only the store's fixed domain reasons are public; unknown exceptions remain opaque.
      const body = {
        error: {
          code,
          message:
            error instanceof CommissionError ? error.message : "Commissioning operation failed",
        },
      };
      return {
        isError: true,
        content: [{ type: "text" as const, text: JSON.stringify(body) }],
        structuredContent: body,
      };
    }
  };
  server.registerTool(
    "commission_read",
    {
      description:
        "Read this worker's commission and durable events after a cursor. Poll to discover commissioner answers; this does not start or resume a worker.",
      inputSchema: readSchema,
    },
    (input) => run(() => options.store.read(caller, input.commissionId, input.after)),
  );
  server.registerTool(
    "commission_consult",
    {
      description:
        "Record a bounded question for the commissioner. Retry the same question ID with identical content.",
      inputSchema: consultSchema,
    },
    (input) => run(() => options.store.consult(caller, input)),
  );
  server.registerTool(
    "commission_report",
    {
      description:
        "Record a checkpoint, failure, immutable proposal, or delivery observation. Retry the same event ID with identical content.",
      inputSchema: reportSchema,
    },
    (input) => run(() => options.store.report(caller, input as ReportInput)),
  );
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    const response = await transport.handleRequest(request);
    response.headers.set("cache-control", "no-store");
    return response;
  } finally {
    await server.close();
  }
}
