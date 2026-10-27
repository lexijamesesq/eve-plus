import { defineState } from "eve/context";
import type { ToolContext } from "eve/tools";
import { verified } from "../../src/config.js";
import extension from "../extension.js";

export const binding = defineState("commissioning.binding", () => ({
  commissionIds: [] as string[],
}));
export function owner(ctx: Pick<ToolContext, "session">) {
  const caller = verified(extension.config.resolveSessionPrincipal(ctx.session.auth.current));
  if (caller.principalId === extension.config.workerPrincipalId)
    throw new Error("Commissioner identity required");
  return caller;
}
export function boundOwner(ctx: Pick<ToolContext, "session">, commissionId: string) {
  const caller = owner(ctx);
  if (!binding.get().commissionIds.includes(commissionId))
    throw new Error("Commission is not bound to this trusted session");
  return caller;
}
