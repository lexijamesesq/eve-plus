import { defineTool } from "eve/tools";
import { decideSchema } from "../../src/schemas.js";
import type { DecisionInput } from "../../src/types.js";
import { boundOwner } from "../lib/binding.js";
import { runtime } from "../lib/runtime.js";
export default defineTool({
  description:
    "Explicitly answer a worker question or accept/request revision of the exact pending proposal. Final answer text never changes the ledger. The consuming application's acceptance requirements apply.",
  inputSchema: decideSchema,
  async execute(input, ctx) {
    const caller = boundOwner(ctx, input.commissionId);
    const decision = input as DecisionInput;
    const store = runtime().store;
    const commission = store.read(caller, input.commissionId);
    if (commission.owner !== caller.principalId) throw new Error("Commissioner identity required");
    return store.decide(caller, decision);
  },
});
