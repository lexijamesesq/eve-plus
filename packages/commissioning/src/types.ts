import type { WorkReference } from "./worker.js";

/**
 * The conversation a commission was opened in, as the consumer identifies it (a Slack thread, a Linear agent
 * session). Captured from trusted session auth at open, compared on every owner call, and never shown to the worker.
 */
export type Conversation = Readonly<Record<string, string>>;
/** Who may act as the owner of a commission, and where they're talking: what `commissioner(auth)` returns. */
export interface Commissioner {
  id: string;
  conversation: Conversation;
}
export interface CommissionSpec {
  brief: string;
  acceptance: string[];
}
/** The repository and PR identify a remote artifact; only the full commit identifies its content. */
export interface ArtifactReference {
  repository: string;
  commit: string;
  pullRequest: string;
}
export interface QuestionInput {
  commissionId: string;
  questionId: string;
  question: { text: string; options?: string[] };
}
type ReportBase = { commissionId: string; eventId: string };
export type ReportInput = ReportBase &
  (
    | { kind: "proposal"; data: { summary: string; artifact: ArtifactReference } }
    | { kind: "checkpoint"; data: { summary: string } }
    | { kind: "failure"; data: { summary: string } }
  );
export type DecisionInput = { commissionId: string; eventId: string } & (
  | { target: "question"; questionId: string; decision: { answer: string } }
  | {
      target: "proposal";
      proposalId: string;
      decision: { verdict: "accept" | "revise"; feedback: string };
    }
);
export type CommissionStatus =
  | "working"
  | "awaiting_commissioner"
  | "needs_review"
  | "revision_requested"
  | "blocked"
  | "accepted";
export type CommissionErrorCode =
  | "invalid_input"
  | "not_found"
  | "forbidden"
  | "conflict"
  | "stale_proposal"
  | "lease_lost";
export interface MutationResult {
  commissionId: string;
  status: CommissionStatus;
}
export type QuestionView = {
  questionId: string;
  question: QuestionInput["question"];
} & ({ status: "pending" } | { status: "answered"; answer: string });
export interface EventView {
  cursor: number;
  eventId: string;
  kind: string;
  payload: unknown;
  createdAt: number;
}
export interface CommissionView extends MutationResult {
  spec: CommissionSpec;
  workReference: WorkReference;
  /** Whether the worker connector has confirmed the handoff; a confirmed handoff doesn't prove the worker started. */
  handoff: { status: "pending" | "confirmed"; lastFailure: OutboxFailureClass | null };
  currentProposal: {
    proposalId: string;
    pending: boolean;
    summary: string;
    artifact: ArtifactReference;
  } | null;
  questions: QuestionView[];
  events: EventView[];
  nextCursor: number;
  /** The worker has been quiet past its grace interval: a prompt to check on it, not a verdict that it stopped. */
  attention?: { kind: "overdue_checkpoint"; lastWorkerActivity: number };
}
export interface OutboxEntry {
  seq: number;
  commissionId: string;
  eventId: string;
  kind: string;
  payload: unknown;
  leaseToken: string;
  /** Delivery attempts so far, this one included. */
  attempt: number;
}
/** Fixed reasons a delivery stays pending. Raw callback and provider errors are never stored or shown. */
export type OutboxFailureClass = "handoff_failed" | "commissioner_unavailable" | "delivery_failed";
export interface StoreOptions {
  now?: () => number;
  overdueAfterMs?: number;
}
