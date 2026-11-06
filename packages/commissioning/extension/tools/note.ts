import { defineTool } from "eve/tools";
import { explain, noteCommission } from "../../src/owner.js";
import { noteSchema } from "../../src/schemas.js";
import { runtime } from "../lib/runtime.js";

export default defineTool({
  description:
    "Send the worker a message on a commission, at any time. This is the only way to tell the worker something: a Linear comment, or anything said in a reply, never reaches it. The worker sees the note on its next read. A note decides nothing: it doesn't answer a question or settle a proposal, so use decide for those.",
  inputSchema: noteSchema,
  execute: (input, ctx) => explain("send the note", () => noteCommission(runtime(), input, ctx)),
});
