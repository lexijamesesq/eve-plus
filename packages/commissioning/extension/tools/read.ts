import { defineTool } from "eve/tools";
import { readSchema } from "../../src/schemas.js";
import { boundOwner } from "../lib/binding.js";
import { runtime } from "../lib/runtime.js";
export default defineTool({
  description:
    "Read a commission bound to this trusted commissioner session, including pending decisions and overdue checkpoint attention.",
  inputSchema: readSchema,
  execute(input, ctx) {
    return runtime().store.read(
      boundOwner(ctx, input.commissionId),
      input.commissionId,
      input.after,
    );
  },
});
