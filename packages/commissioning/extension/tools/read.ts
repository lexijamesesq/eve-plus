import { defineTool } from "eve/tools";
import { explain, readCommission } from "../../src/owner.js";
import { ownerReadSchema } from "../../src/schemas.js";
import { runtime } from "../lib/runtime.js";

export default defineTool({
  description:
    "Read a commission you opened in this conversation: its status, the handoff, the worker's questions and your answers, and the proposal waiting for your decision.",
  inputSchema: ownerReadSchema,
  execute: (input, ctx) =>
    explain("read the commission", () => readCommission(runtime(), input, ctx)),
});
