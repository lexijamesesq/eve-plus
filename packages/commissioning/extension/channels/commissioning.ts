import { DELETE, defineChannel, GET, POST, type RouteHandlerArgs } from "eve/channels";
import { handleWorkerRequest } from "../../src/transport.js";
import extension from "../extension.js";
import { runtime } from "../lib/runtime.js";

const path = extension.config.mcpPath ?? "/commissioning/mcp";
const handle = (request: Request, { to, waitUntil }: RouteHandlerArgs) => {
  const { store, config, drain } = runtime();
  return handleWorkerRequest(request, {
    store,
    authenticateWorker: config.authenticateWorker,
    // Deliver what the worker just wrote without holding its response; the schedule retries anything that fails.
    reconcile: async () => waitUntil(drain(to)),
  });
};

/** The worker's MCP endpoint. */
export default defineChannel({
  routes: [POST(path, handle), GET(path, handle), DELETE(path, handle)],
});
