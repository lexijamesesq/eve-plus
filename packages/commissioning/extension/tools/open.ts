import { defineTool } from "eve/tools";
import { explain, openCommission } from "../../src/owner.js";
import { openSchema } from "../../src/schemas.js";
import { runtime } from "../lib/runtime.js";

export default defineTool({
  description:
    "Commission work from the configured worker: a brief, acceptance criteria, and the work item it's tracked in (for Cyrus, a Linear issue). You'll be told in this conversation when the worker asks, proposes, is blocked or goes quiet.",
  inputSchema: openSchema,
  execute: (input, ctx) =>
    explain("open the commission", () => openCommission(runtime(), input, ctx)),
});
