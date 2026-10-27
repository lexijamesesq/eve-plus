import type { CommissionSpec } from "./types.js";

/** Public work coordinates. Credentials and commissioner context never belong here. */
export interface WorkReference {
  kind: string;
  id: string;
}
/** Bounded, non-secret connector state persisted with the commission. */
export type WorkerBinding = Readonly<Record<string, string>>;
export interface WorkerConnector {
  readonly id: string;
  /** Read-only preparation: resolve and validate the target without changing external state. */
  prepare(input: { commissionId: string; reference: WorkReference }): Promise<WorkerBinding>;
  /** Resolve only after observing the intended handoff; uncertain outcomes must reject. */
  handoff(input: {
    commissionId: string;
    spec: Pick<CommissionSpec, "brief" | "acceptance">;
    binding: WorkerBinding;
  }): Promise<void>;
}
export interface StoredWorkerBinding {
  commissionId: string;
  connectorId: string;
  reference: WorkReference;
  binding: WorkerBinding;
}
