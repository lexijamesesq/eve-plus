import { createHash } from "node:crypto";
import { defineTool } from "eve/tools";
import { openSchema } from "../../src/schemas.js";
import extension from "../extension.js";
import { binding, owner } from "../lib/binding.js";
import { runtime } from "../lib/runtime.js";

export default defineTool({
  description:
    "Open a commission for the configured worker. The current verified commissioner and conversation snapshot are bound by the host.",
  inputSchema: openSchema,
  async execute(input, ctx) {
    const caller = owner(ctx);
    const commissionId = createHash("sha256")
      .update(`${ctx.session.id}:${ctx.callId}`)
      .digest("hex");
    const messages = ctx.messages.flatMap((message) => {
      if (message.role !== "user" && message.role !== "assistant") return [];
      const content =
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((part) => part.type === "text")
              .map((part) => ("text" in part ? part.text : ""))
              .join("\n");
      return content ? [{ role: message.role, content }] : [];
    });
    if (Buffer.byteLength(JSON.stringify(messages)) > 131072)
      throw new Error(
        "Commissioner context exceeds 128 KiB; compact the conversation before commissioning",
      );
    const source = extension.config.captureSource?.(ctx);
    const initiator = ctx.session.auth.initiator ?? ctx.session.auth.current;
    const result = runtime().store.open(
      caller,
      { commissionId, spec: input.spec },
      { verified: true, principalId: extension.config.workerPrincipalId },
      {
        originSessionId: ctx.session.id,
        messages,
        ...(source ? { source } : {}),
        ...(initiator
          ? {
              initiator: {
                principalId: initiator.principalId,
                authenticator: initiator.authenticator,
                principalType: initiator.principalType,
              },
            }
          : {}),
      },
    );
    binding.update((state) => ({
      commissionIds: [...new Set([...state.commissionIds, commissionId])],
    }));
    return result;
  },
});
