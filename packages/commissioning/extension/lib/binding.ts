import { defineState } from "eve/context";
import type { ToolContext } from "eve/tools";
import { verified } from "../../src/config.js";
import extension from "../extension.js";
import { runtime } from "./runtime.js";

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
  const store = runtime().store;
  if (store.read(caller, commissionId).owner !== caller.principalId)
    throw new Error("Commissioner identity required");
  const context = store.context(commissionId);
  const authorize = extension.config.authorizeOwnerSession;
  if (authorize !== undefined) {
    let allowed = false;
    try {
      allowed =
        context?.source !== undefined && authorize({ session: ctx.session, context }) === true;
    } catch {
      // Host policy failures deny without exposing private context or errors.
    }
    if (!allowed) throw new Error("Owner session authorization required");
    return caller;
  }
  // Explicit recovery revokes every old session, including a restored session with stale durable state.
  if (context?.activeSessionId !== undefined) {
    if (context.activeSessionId !== ctx.session.id)
      throw new Error("Commission is bound to a different active session");
    return caller;
  }
  if (context?.originSessionId === ctx.session.id) return caller;
  if (!binding.get().commissionIds.includes(commissionId))
    throw new Error("Commission is not bound to this trusted session");
  return caller;
}
