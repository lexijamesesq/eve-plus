import { defineTool } from "eve/tools";
import { decideCommission, explain } from "../../src/owner.js";
import { decideSchema } from "../../src/schemas.js";
import { runtime } from "../lib/runtime.js";

export default defineTool({
  description:
    "Answer the worker's question, or accept the pending proposal or ask for a revision of it. Only this tool records a decision: saying it in a reply doesn't. Give each decision its own event ID.",
  inputSchema: decideSchema,
  execute: (input, ctx) =>
    explain("record the decision", () => decideCommission(runtime(), input, ctx)),
});
