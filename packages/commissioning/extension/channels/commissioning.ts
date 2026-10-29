import { DELETE, defineChannel, GET, POST, type RouteHandlerArgs } from "eve/channels";
import { handleWorkerRequest } from "../../src/transport.js";
import extension from "../extension.js";
import { runtime } from "../lib/runtime.js";

const path = extension.config.mcpPath ?? "/commissioning/mcp";
const handle = (request: Request, { to, waitUntil }: RouteHandlerArgs) =>
  handleWorkerRequest(request, {
    store: () => runtime().store,
    authenticateWorker: extension.config.authenticateWorker,
    // Deliver what the worker just wrote without holding its response; the schedule retries anything that fails.
    reconcile: async () => waitUntil(runtime().drain(to)),
  });

/** The worker's MCP endpoint. */
export default defineChannel({
  routes: [POST(path, handle), GET(path, handle), DELETE(path, handle)],
});
