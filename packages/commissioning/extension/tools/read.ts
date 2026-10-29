import { defineTool } from "eve/tools";
import { z } from "zod";
import { explain, readCommission } from "../../src/owner.js";
import { runtime } from "../lib/runtime.js";

export default defineTool({
  description:
    "Read a commission you opened in this conversation: its status, the handoff, the worker's questions and your answers, and the proposal waiting for your decision.",
  inputSchema: z.object({ commissionId: z.string().min(1).max(256) }).strict(),
  execute: (input, ctx) =>
    explain("read the commission", () => readCommission(runtime(), input, ctx)),
});
