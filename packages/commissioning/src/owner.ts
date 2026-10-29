import { createHash } from "node:crypto";
import type { ToolContext } from "eve/tools";
import type { CommissioningConfig } from "./config.js";
import { commissionerSchema } from "./schemas.js";
import { CommissionError, type CommissionStore } from "./store.js";
import type { Commissioner, CommissionView, DecisionInput } from "./types.js";
import type { WorkReference } from "./worker.js";

// The commissioner's three tools, as plain functions over the store. The owner and conversation always come from the
// session's verified auth through the consumer's `commissioner`, never from tool arguments.
type Context = Pick<ToolContext, "session" | "callId">;
interface Owner {
  store: CommissionStore;
  config: Pick<CommissioningConfig, "commissioner" | "worker">;
}

function commissioner(config: Owner["config"], ctx: Context): Commissioner {
  const parsed = commissionerSchema.safeParse(config.commissioner(ctx.session.auth.current));
  if (!parsed.success) throw new CommissionError("forbidden", "This session can't commission work");
  return parsed.data;
}

/** A refusal the commissioner can act on comes back as a sentence; anything else is a tool error. */
export async function explain(
  attempt: string,
  run: () => string | Promise<string>,
): Promise<string> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof CommissionError) return `Couldn't ${attempt}: ${error.message}.`;
    throw error;
  }
}

export async function openCommission(
  { store, config }: Owner,
  input: { spec: { brief: string; acceptance: string[] }; workReference: WorkReference },
  ctx: Context,
): Promise<string> {
  const owner = commissioner(config, ctx);
  // Derived from the call, so eve's retry of the same call opens the same commission.
  const commissionId = createHash("sha256").update(`${ctx.session.id}:${ctx.callId}`).digest("hex");
  // Preparing reads the work record; a retry reuses the binding the first call stored.
  const binding = store.exists(commissionId)
    ? {}
    : await config.worker.prepare({ commissionId, reference: input.workReference }).catch(() => {
        throw new CommissionError(
          "invalid_input",
          "The worker couldn't accept that work reference",
        );
      });
  store.open(owner, {
    commissionId,
    spec: input.spec,
    workReference: input.workReference,
    connectorId: config.worker.id,
    binding,
  });
  return `Opened commission ${commissionId} for ${input.workReference.kind} ${input.workReference.id}. The worker is being handed the work; you'll hear here when it asks, proposes, reports a failure or goes quiet.`;
}

export function readCommission(
  { store, config }: Owner,
  input: { commissionId: string },
  ctx: Context,
): string {
  return describe(store.read(input.commissionId, 0, commissioner(config, ctx)));
}

export function decideCommission(
  { store, config }: Owner,
  input: DecisionInput,
  ctx: Context,
): string {
  const result = store.decide(commissioner(config, ctx), input);
  const done =
    input.target === "question"
      ? `Answered question ${input.questionId}`
      : input.decision.verdict === "accept"
        ? `Accepted proposal ${input.proposalId}`
        : `Asked for a revision of proposal ${input.proposalId}`;
  return `${done} on commission ${result.commissionId}; it's now ${result.status.replaceAll("_", " ")}. The worker reads this on its next poll.`;
}

function describe(view: CommissionView): string {
  const lines = [
    `Commission ${view.commissionId}: ${view.status.replaceAll("_", " ")}.`,
    `Work: ${view.workReference.kind} ${view.workReference.id}. ${view.spec.brief}`,
    `Acceptance:\n${view.spec.acceptance.map((value) => `- ${value}`).join("\n")}`,
    view.handoff.status === "confirmed"
      ? "Handoff: confirmed (the worker was handed the work; that doesn't show it started)."
      : `Handoff: not yet confirmed${view.handoff.lastFailure ? ` (last attempt: ${view.handoff.lastFailure.replaceAll("_", " ")})` : ""}.`,
  ];
  for (const question of view.questions)
    lines.push(
      question.status === "pending"
        ? `Question ${question.questionId}, waiting for your answer: ${question.question.text}`
        : `Question ${question.questionId}: ${question.question.text}\nAnswered: ${question.answer}`,
    );
  const proposal = view.currentProposal;
  if (proposal)
    lines.push(
      `${proposal.pending ? "Proposal waiting for your decision" : "Latest proposal"} ${proposal.proposalId}: ${proposal.summary}\nPR: ${proposal.artifact.pullRequest}\nCommit: ${proposal.artifact.commit}`,
    );
  if (view.attention)
    lines.push(
      `The worker has been quiet since ${new Date(view.attention.lastWorkerActivity).toISOString()}. It may have stopped.`,
    );
  return lines.join("\n");
}
