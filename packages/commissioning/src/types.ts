/** Only the host's authenticated principal resolver may construct this value. Never accept it from tool arguments. */
export interface Caller {
  principalId: string;
  verified: true;
}
export interface CommissionSpec {
  brief: string;
  acceptance: string[];
  privateGuidance?: string;
}
export interface OpenInput {
  commissionId: string;
  spec: CommissionSpec;
}
export interface QuestionInput {
  commissionId: string;
  questionId: string;
  question: { text: string; options?: string[] };
}
/** The repository and PR identify a remote artifact; only the full commit identifies its immutable content. */
export interface ArtifactReference {
  repository: string;
  commit: string;
  pullRequest: string;
}
type ReportBase = { commissionId: string; eventId: string };
export type ReportInput = ReportBase &
  (
    | { kind: "proposal"; data: { summary: string; artifact: ArtifactReference } }
    | { kind: "checkpoint"; data: { summary: string } }
    | { kind: "failure"; data: { summary: string } }
    | { kind: "reviewed"; data: { summary: string; proposalId: string } }
    | { kind: "merged"; data: { summary: string; proposalId: string } }
    | { kind: "deployed"; data: { summary: string; proposalId: string } }
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
  | "unverified_caller"
  | "not_found"
  | "forbidden"
  | "conflict"
  | "stale_proposal"
  | "unsupported_schema"
  | "lease_lost";
export interface MutationResult {
  commissionId: string;
  status: CommissionStatus;
}
export type QuestionView = {
  commissionId: string;
  questionId: string;
  question: QuestionInput["question"];
} & ({ status: "pending" } | { status: "answered"; answer: { answer: string } });
export interface EventView {
  cursor: number;
  eventId: string;
  kind: string;
  payload: unknown;
  createdAt: number;
}
export interface CommissionView extends MutationResult {
  owner: string;
  worker: string;
  spec: CommissionSpec;
  proposalId: string | null;
  proposalPending: boolean;
  currentProposal: { proposalId: string; summary: string; artifact: ArtifactReference } | null;
  /** Owner-only delivery diagnostics. Contains fixed failure classes, never raw exceptions. */
  notification?: {
    pending: number;
    attemptCount: number;
    lastAttemptAt: number | null;
    failureClass: OutboxFailureClass | null;
  };
  delivery: { reviewed: boolean; merged: boolean; deployed: boolean };
  questions: QuestionView[];
  events: EventView[];
  nextCursor: number;
  attention?: { kind: "overdue_checkpoint"; lastWorkerActivity: number };
}
export interface PendingWork {
  commissionId: string;
  kind: "question" | "proposal";
  id: string;
  owner: string;
  worker: string;
}
export interface OutboxEntry {
  seq: number;
  commissionId: string;
  eventId: string;
  recipient: string;
  kind: string;
  payload: unknown;
  leaseToken: string;
  attemptCount: number;
  lastAttemptAt: number;
}
export type OutboxFailureClass = "identity_unavailable" | "dispatch_failed";
export interface StoreOptions {
  now?: () => number;
  overdueAfterMs?: number;
}

/** Captured by the trusted host, never exposed to worker tools or event envelopes. */
export type CommissionSource = Readonly<Record<string, string>>;
export interface CommissionerContext {
  originSessionId: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  source?: CommissionSource;
  initiator?: { principalId: string; authenticator: string; principalType: string };
  /** Set only by an explicitly authorized host rebind; origin and captured provenance never change. */
  activeSessionId?: string;
}
export interface RebindSessionInput {
  commissionId: string;
  eventId: string;
  expectedActiveSessionId: string;
  activeSessionId: string;
  source: CommissionSource;
}
export interface RebindSessionResult {
  commissionId: string;
  activeSessionId: string;
}
