import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import manifest from "../package.json" with { type: "json" };
import type { CommissioningConfig } from "./config.js";
import { consultSchema, readSchema, reportSchema, reportToolSchema } from "./schemas.js";
import { CommissionError, type CommissionStore } from "./store.js";

/**
 * The worker's endpoint: a stateless MCP server with three tools, read, consult and report. It has no owner
 * operations, so a worker credential can never answer, accept or revise. The store opens only once the request is
 * authenticated, so a refused request never touches the ledger. `reconcile` runs after a write commits.
 */
export async function handleWorkerRequest(
  request: Request,
  options: {
    store: () => CommissionStore;
    authenticateWorker: CommissioningConfig["authenticateWorker"];
    reconcile?: () => Promise<unknown>;
  },
): Promise<Response> {
  let authenticated = false;
  try {
    authenticated = (await options.authenticateWorker(request)) === true;
  } catch {
    // A failing check is a refusal.
  }
  if (!authenticated)
    return new Response("Unauthorized", {
      status: 401,
      headers: { "www-authenticate": 'Bearer realm="commissioning"', "cache-control": "no-store" },
    });
  const store = options.store();
  const server = new McpServer({ name: "eve-plus-commissioning", version: manifest.version });
  const run = async (operation: () => unknown, mutation = false) => {
    try {
      const result = operation();
      if (mutation && options.reconcile) {
        try {
          await options.reconcile();
        } catch {
          // The outbox keeps the notice; the schedule retries it.
        }
      }
      const body = { result, recorded: true };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(body) }],
        structuredContent: body,
      };
    } catch (error) {
      // Only the store's own reasons reach the worker; anything else stays opaque.
      const body = {
        error:
          error instanceof CommissionError
            ? { code: error.code, message: error.message }
            : { code: "internal", message: "Commissioning operation failed" },
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
        "Read the commission and its events after a cursor. Poll it to find the commissioner's answers and decisions; it doesn't start or resume work.",
      inputSchema: readSchema,
    },
    (input) => run(() => store.read(input.commissionId, input.after)),
  );
  server.registerTool(
    "commission_consult",
    {
      description:
        "Ask the commissioner a bounded question. Retry with the same question ID and identical content; new content needs a new ID.",
      inputSchema: consultSchema,
    },
    (input) => run(() => store.consult(input), true),
  );
  server.registerTool(
    "commission_report",
    {
      description:
        "Report a checkpoint, a failure, or an immutable proposal (repository, full commit, PR). Retry with the same event ID and identical content.",
      inputSchema: reportToolSchema,
    },
    (input) =>
      run(() => {
        const report = reportSchema.safeParse(input);
        if (!report.success)
          throw new CommissionError(
            "invalid_input",
            "A proposal needs an artifact (HTTPS repository, full 40-hex commit, and a PR of that repository); a checkpoint or failure takes only a summary",
          );
        return store.report(report.data);
      }, true),
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
