import { createHash } from "node:crypto";
import {
  type ChannelFrom,
  DELETE,
  defineChannel,
  GET,
  POST,
  type RouteHandlerArgs,
} from "eve/channels";
import type { OwnerDelivery } from "../../src/dispatch.js";
import { handleWorkerRequest } from "../../src/transport.js";
import extension from "../extension.js";
import { binding } from "../lib/binding.js";
import { runtime } from "../lib/runtime.js";

export async function deliverOwner(
  from: ChannelFrom,
  delivery: Omit<OwnerDelivery, "entry" | "auth"> & {
    entry: Pick<OwnerDelivery["entry"], "commissionId" | "eventId">;
    auth: import("eve/context").SessionAuthContext | null;
  },
) {
  const source = from(delivery.entry.commissionId);
  // create seeds the original snapshot once; retries and later reports do not duplicate history.
  const { session } = await source.create({ auth: delivery.auth, history: delivery.history });
  if (delivery.context?.activeSessionId && session.id !== delivery.context.activeSessionId)
    throw new Error("Canonical commissioner source does not match the active session");
  const result = await session.send(delivery.message, {
    auth: delivery.auth,
    turnPolicy: "queue",
    idempotencyKey: createHash("sha256")
      .update(`${delivery.entry.commissionId}:${delivery.entry.eventId}`)
      .digest("hex"),
  });
  if (result.status !== "accepted") throw new Error("Canonical commissioner session is inactive");
  return session;
}

const handle = (
  request: Request,
  { from, waitUntil }: Pick<RouteHandlerArgs, "from" | "waitUntil">,
) => {
  const { store, drain } = runtime();
  return handleWorkerRequest(request, {
    store,
    config: extension.config,
    reconcile: async () => {
      waitUntil(drain((delivery) => deliverOwner(from, delivery)));
    },
  });
};

export default defineChannel({
  turnPolicy: "queue",
  routes: [
    POST(extension.config.mcpPath ?? "/commissioning/mcp", handle),
    GET(extension.config.mcpPath ?? "/commissioning/mcp", handle),
    DELETE(extension.config.mcpPath ?? "/commissioning/mcp", handle),
  ],
  async receive(
    input: {
      target: { commissionId: string; eventId: string };
      auth: import("eve/context").SessionAuthContext | null;
      message: string | unknown[];
    },
    { from },
  ) {
    const caller = extension.config.resolveSessionPrincipal(input.auth);
    if (caller?.verified !== true || caller.principalId === extension.config.workerPrincipalId)
      throw new Error("Verified commissioner required");
    const commission = runtime().store.read(caller, input.target.commissionId);
    if (commission.owner !== caller.principalId) throw new Error("Wrong commissioner");
    const context = runtime().store.context(input.target.commissionId);
    return deliverOwner(from, {
      entry: input.target,
      auth: input.auth,
      context,
      history:
        context?.messages.map((message) => ({ role: message.role, text: message.content })) ?? [],
      message: typeof input.message === "string" ? input.message : JSON.stringify(input.message),
    });
  },
  events: {
    "turn.started"(_event, channel, ctx) {
      const commissionId = channel.continuation?.token;
      if (!commissionId) throw new Error("Trusted commission continuation required");
      const caller = extension.config.resolveSessionPrincipal(ctx.session.auth.current);
      if (caller?.verified !== true || caller.principalId === extension.config.workerPrincipalId)
        throw new Error("Verified commissioner required");
      const commission = runtime().store.read(caller, commissionId);
      if (commission.owner !== caller.principalId) throw new Error("Wrong commissioner");
      // The continuation is host-authored. No model input, worker text, or final JSON seeds authority.
      binding.update(() => ({ commissionIds: [commissionId] }));
    },
  },
});
