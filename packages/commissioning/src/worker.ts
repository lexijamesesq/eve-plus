import type { CommissionSpec } from "./types.js";

/** Where the worker finds the work, such as a Linear issue. Public coordinates only. */
export interface WorkReference {
  kind: string;
  id: string;
}
/** Bounded, non-secret connector state, persisted with the commission so a retry hands off to the same target. */
export type WorkerBinding = Readonly<Record<string, string>>;
/** The seam a worker integration implements. `cyrus()` is the one this package ships. */
export interface WorkerConnector {
  readonly id: string;
  /**
   * Read-only: resolve and check the target without changing anything outside. Reject with an error carrying
   * `retryable: true` when the failure is transient, such as the work system being unreachable; any other rejection
   * refuses the work reference.
   */
  prepare(input: { commissionId: string; reference: WorkReference }): Promise<WorkerBinding>;
  /** Resolve only once the handoff is observed; an uncertain outcome must reject so it's retried. */
  handoff(input: {
    commissionId: string;
    spec: CommissionSpec;
    binding: WorkerBinding;
  }): Promise<void>;
  /**
   * Close out the work after the commissioner accepts the proposal. Delivered at least once, so it must be safe to
   * repeat: resolve when the work is already closed out. A connector that can't act right now (for instance its
   * credential is missing) must reject, so the closeout stays pending and is retried instead of being lost.
   */
  complete(input: { commissionId: string; binding: WorkerBinding }): Promise<void>;
}
