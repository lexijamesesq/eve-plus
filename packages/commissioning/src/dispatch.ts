import { randomUUID } from "node:crypto";
import type { SessionHistoryMessage } from "eve/channels";
import type { SessionAuthContext } from "eve/context";
import type { CommissioningConfig } from "./config.js";
import type { CommissionStore } from "./store.js";
import type { OutboxEntry, OutboxFailureClass } from "./types.js";

export interface OwnerDelivery {
  entry: OutboxEntry;
  auth: SessionAuthContext;
  history: SessionHistoryMessage[];
  message: string;
}
/** One dispatcher per mount. Durable leases handle restart; eve's key window bounds dispatch deduplication. */
export function createDispatcher(store: CommissionStore, config: CommissioningConfig) {
  const consumerId = randomUUID();
  let active: Promise<void> | undefined;
  return (deliver: (delivery: OwnerDelivery) => Promise<unknown>): Promise<void> => {
    if (active) return active;
    active = (async () => {
      store.reconcileOverdue();
      let afterSeq = 0;
      for (let index = 0; index < 100; index++) {
        // Acquire a fresh lease immediately before each send, rather than aging an entire batch.
        const entry = store.claimOutbox({ consumerId, limit: 1, leaseMs: 120000, afterSeq })[0];
        if (!entry) break;
        afterSeq = entry.seq;
        let failureClass: OutboxFailureClass = "identity_unavailable";
        try {
          const auth = await config.resolveDeliveryAuth(entry.recipient);
          const caller = config.resolveSessionPrincipal(auth);
          if (
            !auth ||
            caller?.verified !== true ||
            caller.principalId !== entry.recipient ||
            auth.principalId !== entry.recipient
          ) {
            throw new Error("Delivery principal unavailable");
          }
          const commission = store.read(caller, entry.commissionId);
          if (commission.owner !== caller.principalId)
            throw new Error("Delivery requires commissioner");
          const context = store.context(entry.commissionId);
          const history =
            context?.messages.map((message) => ({ role: message.role, text: message.content })) ??
            [];
          failureClass = "dispatch_failed";
          await deliver({
            entry,
            auth,
            history,
            message: JSON.stringify({
              commissionId: entry.commissionId,
              eventId: entry.eventId,
              kind: entry.kind,
              payload: entry.payload,
              spec: commission.spec,
            }),
          });
          store.acknowledgeOutbox(entry.seq, entry.leaseToken);
        } catch {
          try {
            store.releaseOutbox(entry.seq, entry.leaseToken, failureClass);
          } catch {
            /* Expired leases are already retryable. */
          }
          // Continue unrelated commissions. Never log callback or worker content.
        }
      }
    })().finally(() => {
      active = undefined;
    });
    return active;
  };
}
