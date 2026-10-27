import { createHash } from "node:crypto";
import { type ChannelFrom, DELETE, defineChannel, GET, POST } from "eve/channels";
import type { OwnerDelivery } from "../../src/dispatch.js";
import { handleWorkerRequest } from "../../src/transport.js";
import extension from "../extension.js";
import { binding } from "../lib/binding.js";
import { runtime } from "../lib/runtime.js";

export async function deliverOwner(from: ChannelFrom, delivery: OwnerDelivery) {
  const source = from(delivery.entry.commissionId);
  // create seeds the original snapshot once; retries and later reports do not duplicate history.
  await source.create({ auth: delivery.auth, history: delivery.history });
  return source.send(delivery.message, {
    auth: delivery.auth,
    turnPolicy: "queue",
    idempotencyKey: createHash("sha256")
      .update(`${delivery.entry.commissionId}:${delivery.entry.eventId}`)
      .digest("hex"),
  });
}

const handle = (request: Request, { from }: { from: ChannelFrom }) => {
  const { store, drain } = runtime();
  return handleWorkerRequest(request, {
    store,
    config: extension.config,
    reconcile: () => drain((delivery) => deliverOwner(from, delivery)),
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
    const source = from(input.target.commissionId);
    await source.create({
      auth: input.auth,
      history: context?.messages.map((message) => ({ role: message.role, text: message.content })),
    });
    return source.send(
      typeof input.message === "string" ? input.message : JSON.stringify(input.message),
      {
        auth: input.auth,
        turnPolicy: "queue",
        idempotencyKey: createHash("sha256")
          .update(`${input.target.commissionId}:${input.target.eventId}`)
          .digest("hex"),
      },
    );
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
