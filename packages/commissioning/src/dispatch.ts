import type { RouteHandlerArgs } from "eve/channels";
import type { CommissioningConfig } from "./config.js";
import { resolveCommissioner } from "./owner.js";
import type { CommissionStore } from "./store.js";
import type { OutboxEntry, OutboxFailureClass } from "./types.js";

type To = RouteHandlerArgs["to"];

/** The notice the commissioner's conversation receives, in the words the model reads. */
export function notice(entry: OutboxEntry): string {
  const { commissionId } = entry;
  const payload = entry.payload as {
    questionId?: string;
    question?: { text: string; options?: string[] };
    eventId?: string;
    data?: {
      summary: string;
      artifact?: { repository: string; commit: string; pullRequest: string };
    };
  };
  const read = `Read it with the commissioning read tool (commission ${commissionId}).`;
  switch (entry.kind) {
    case "question": {
      const options = payload.question?.options?.length
        ? `\nOptions: ${payload.question.options.join(" | ")}`
        : "";
      return `The worker asked a question on commission ${commissionId} (question ${payload.questionId}):\n${payload.question?.text}${options}\nAnswer it with the commissioning decide tool.`;
    }
    case "proposal": {
      const artifact = payload.data?.artifact;
      return `The worker proposed a change for commission ${commissionId} (proposal ${payload.eventId}):\n${payload.data?.summary}\nPR: ${artifact?.pullRequest}\nCommit: ${artifact?.commit}\nReview it, then accept it or ask for a revision with the commissioning decide tool.`;
    }
    case "failure":
      return `The worker reported it's blocked on commission ${commissionId}:\n${payload.data?.summary}\n${read}`;
    case "overdue_checkpoint":
      return `The worker has gone quiet on commission ${commissionId}: no checkpoint, question or proposal within its grace interval. It may have stopped. ${read}`;
    default:
      return `Commission ${commissionId} has a new ${entry.kind} event. ${read}`;
  }
}

/**
 * One dispatcher per mount: hands new work to the worker and tells the commissioner, in the conversation the
 * commission was opened in, what the worker asked, proposed or reported. Delivery is at least once: a crash after a
 * send and before its acknowledgement sends it again.
 */
export function createDispatcher(store: CommissionStore, config: CommissioningConfig) {
  let active: Promise<void> | undefined;
  return (to: To): Promise<void> => {
    // A sweep already running covers this call too.
    if (active) return active;
    active = (async () => {
      store.reconcileOverdue();
      for (const seq of store.pendingOutbox()) {
        const entry = store.claimOutbox(seq);
        if (!entry) continue;
        let failure: OutboxFailureClass = "delivery_failed";
        try {
          const commission = store.delivery(entry.commissionId);
          if (entry.kind === "handoff") {
            failure = "handoff_failed";
            if (commission.connectorId !== config.worker.id)
              throw new Error("The worker connector changed since this commission was opened");
            await config.worker.handoff({
              commissionId: entry.commissionId,
              spec: commission.spec,
              binding: commission.binding,
            });
          } else {
            failure = "commissioner_unavailable";
            const route = config.deliver(commission.conversation);
            // The delivered turn has to be able to answer, so its auth must pass the same owner rule the decide
            // tool applies; otherwise the notice would arrive somewhere decide refuses.
            store.owned(resolveCommissioner(config, route.auth), entry.commissionId);
            failure = "delivery_failed";
            await to(route.channel, route.target).send(notice(entry), {
              auth: route.auth,
              turnPolicy: "queue",
            });
          }
          store.acknowledgeOutbox(entry.seq, entry.leaseToken);
        } catch {
          // Leave it for the next sweep, and say so: a notice that keeps failing would otherwise be silent. Fixed
          // fields only; the notice, the auth and callback or provider errors can carry secrets.
          console.warn(
            `[commissioning] delivery failed: commission=${entry.commissionId} reason=${failure} attempt=${entry.attempt}`,
          );
          try {
            store.releaseOutbox(entry.seq, entry.leaseToken, failure);
          } catch {
            // An expired lease is already due again.
          }
        }
      }
    })().finally(() => {
      active = undefined;
    });
    return active;
  };
}
