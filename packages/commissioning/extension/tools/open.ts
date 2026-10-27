import { createHash } from "node:crypto";
import { defineTool } from "eve/tools";
import { openSchema } from "../../src/schemas.js";
import { CommissionError } from "../../src/store.js";
import type { StoredWorkerBinding, WorkerBinding } from "../../src/worker.js";
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
    const store = runtime().store;
    const connector = extension.config.worker;
    if (connector && !input.workReference)
      throw new CommissionError("invalid_input", "The configured worker requires a work reference");
    if (!connector && input.workReference)
      throw new CommissionError("invalid_input", "A work reference requires a configured worker");
    let exists = false;
    try {
      store.read(caller, commissionId);
      exists = true;
    } catch (error) {
      if (!(error instanceof CommissionError) || error.code !== "not_found") throw error;
    }
    let workerBinding: StoredWorkerBinding | undefined;
    if (exists) {
      workerBinding = store.workerBinding(commissionId);
      if (workerBinding?.connectorId !== connector?.id)
        throw new CommissionError("conflict", "The original worker connector cannot change");
      if (
        workerBinding &&
        (workerBinding.reference.kind !== input.workReference?.kind ||
          workerBinding.reference.id !== input.workReference?.id)
      )
        throw new CommissionError("conflict", "Event ID was already used with different input");
    } else if (connector && input.workReference) {
      let prepared: WorkerBinding;
      try {
        prepared = await connector.prepare({ commissionId, reference: { ...input.workReference } });
      } catch {
        throw new CommissionError("invalid_input", "Worker preparation failed");
      }
      workerBinding = {
        commissionId,
        connectorId: connector.id,
        reference: input.workReference,
        binding: prepared,
      };
    }
    const originalContext = exists ? store.context(commissionId) : undefined;
    if (originalContext) delete originalContext.activeSessionId;
    const context = exists
      ? originalContext
      : (() => {
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
          return {
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
          };
        })();
    const result = store.open(
      caller,
      {
        commissionId,
        spec: input.spec,
        ...(input.workReference ? { workReference: input.workReference } : {}),
      },
      { verified: true, principalId: extension.config.workerPrincipalId },
      context,
      workerBinding ? { workerBinding } : {},
    );
    binding.update((state) => ({
      commissionIds: [...new Set([...state.commissionIds, commissionId])],
    }));
    return result;
  },
});
