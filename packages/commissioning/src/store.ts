import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type {
  ArtifactReference,
  CommissionErrorCode,
  Commissioner,
  CommissionSpec,
  CommissionStatus,
  CommissionView,
  Conversation,
  DecisionInput,
  MutationResult,
  OutboxEntry,
  OutboxFailureClass,
  QuestionInput,
  QuestionView,
  ReportInput,
  StoreOptions,
} from "./types.js";
import type { WorkerBinding, WorkReference } from "./worker.js";

export class CommissionError extends Error {
  constructor(
    public readonly code: CommissionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CommissionError";
  }
}
function fail(code: CommissionErrorCode, message: string): never {
  throw new CommissionError(code, message);
}
/** Stable JSON: key order can't change an operation's identity or a conversation's equality. */
export function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return fail("invalid_input", "Inputs must contain JSON values only");
}
function hash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

const WORKER = "worker";
const SCHEMA = `
CREATE TABLE commissions(id TEXT PRIMARY KEY,owner TEXT NOT NULL,conversation TEXT NOT NULL,spec TEXT NOT NULL,
  work_reference TEXT NOT NULL,connector_id TEXT NOT NULL,binding TEXT NOT NULL,state TEXT NOT NULL,
  proposal_id TEXT,proposal_pending INTEGER NOT NULL DEFAULT 0,updated INTEGER NOT NULL,heartbeat INTEGER NOT NULL);
CREATE TABLE questions(commission_id TEXT NOT NULL REFERENCES commissions(id),id TEXT NOT NULL,question TEXT NOT NULL,
  answer TEXT,PRIMARY KEY(commission_id,id));
CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,commission_id TEXT NOT NULL REFERENCES commissions(id),
  id TEXT NOT NULL,actor TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,created INTEGER NOT NULL,
  UNIQUE(commission_id,id));
CREATE TABLE operations(commission_id TEXT NOT NULL REFERENCES commissions(id),id TEXT NOT NULL,hash TEXT NOT NULL,
  result TEXT NOT NULL,PRIMARY KEY(commission_id,id));
CREATE TABLE outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,commission_id TEXT NOT NULL REFERENCES commissions(id),
  event_id TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,delivered INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,lease_until INTEGER,attempt_count INTEGER NOT NULL DEFAULT 0,failure_class TEXT,
  UNIQUE(commission_id,event_id));
CREATE INDEX outbox_pending ON outbox(delivered,lease_until,seq);
PRAGMA user_version=1;`;

interface CommissionRow {
  id: string;
  owner: string;
  conversation: string;
  spec: string;
  work_reference: string;
  connector_id: string;
  binding: string;
  state: "working" | "revision_requested" | "blocked" | "accepted";
  proposal_id: string | null;
  proposal_pending: number;
  updated: number;
  heartbeat: number;
}
interface OutboxRow {
  seq: number;
  commission_id: string;
  event_id: string;
  kind: string;
  payload: string;
}

// `updated` moves on worker activity and on the commissioner's hand-back (an answer, a revision request), so a late
// answer earns the worker a full new interval; `heartbeat` is worker activity alone. Review, blocked and accepted work
// is waiting on someone other than the worker, so it can't be overdue.
const overdueEligibility = `c.state IN ('working','revision_requested') AND c.proposal_pending=0
  AND max(c.updated,c.heartbeat)<?
  AND NOT EXISTS (SELECT 1 FROM questions q WHERE q.commission_id=c.id AND q.answer IS NULL)`;

/** The commissioning ledger: one SQLite file per mount, read and written by one process. */
export class CommissionStore {
  private readonly db: Database.Database;
  private readonly now: () => number;
  private readonly overdueAfterMs: number;
  constructor(path: string, options: StoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.overdueAfterMs = options.overdueAfterMs ?? 60_000;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    try {
      this.db.pragma("foreign_keys = ON");
      this.db.pragma("busy_timeout = 5000");
      const version = this.db.pragma("user_version", { simple: true }) as number;
      if (version === 0) this.db.transaction(() => this.db.exec(SCHEMA)).immediate();
      else if (version !== 1) fail("invalid_input", `Unsupported commissioning schema ${version}`);
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = FULL");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close(): void {
    this.db.close();
  }
  private row(id: string): CommissionRow {
    return (
      (this.db.prepare("SELECT * FROM commissions WHERE id=?").get(id) as
        | CommissionRow
        | undefined) ?? fail("not_found", "Commission not found")
    );
  }
  /** The owner may act only from the conversation the commission was opened in. */
  private owned(commissioner: Commissioner, id: string): CommissionRow {
    const row = this.row(id);
    if (row.owner !== commissioner.id) fail("not_found", "Commission not found");
    if (row.conversation !== canonical(commissioner.conversation))
      fail("forbidden", "Act on a commission from the conversation it was opened in");
    return row;
  }
  // A retried call with the same ID and input returns its first result; the same ID with other input is refused.
  private operation<T>(
    id: string,
    key: string,
    actor: string,
    input: unknown,
    execute: () => T,
  ): T {
    return this.db
      .transaction(() => {
        const digest = hash({ actor, input });
        const previous = this.db
          .prepare("SELECT hash,result FROM operations WHERE commission_id=? AND id=?")
          .get(id, key) as { hash: string; result: string } | undefined;
        if (previous) {
          if (previous.hash !== digest)
            fail("conflict", "This ID was already used with different input");
          return JSON.parse(previous.result) as T;
        }
        const result = execute();
        this.db
          .prepare("INSERT INTO operations VALUES(?,?,?,?)")
          .run(id, key, digest, canonical(result));
        return result;
      })
      .immediate();
  }
  private event(
    id: string,
    eventId: string,
    actor: string,
    kind: string,
    payload: unknown,
    notify: boolean,
  ) {
    const encoded = canonical(payload);
    this.db
      .prepare(
        "INSERT INTO events(commission_id,id,actor,kind,payload,created) VALUES(?,?,?,?,?,?)",
      )
      .run(id, eventId, actor, kind, encoded, this.now());
    if (notify)
      this.db
        .prepare("INSERT INTO outbox(commission_id,event_id,kind,payload) VALUES(?,?,?,?)")
        .run(id, eventId, kind, encoded);
  }
  private touch(id: string, worker: boolean): void {
    this.db
      .prepare(`UPDATE commissions SET updated=?${worker ? ",heartbeat=?" : ""} WHERE id=?`)
      .run(...(worker ? [this.now(), this.now(), id] : [this.now(), id]));
  }
  private unanswered(id: string): number {
    return (
      this.db
        .prepare("SELECT count(*) AS n FROM questions WHERE commission_id=? AND answer IS NULL")
        .get(id) as { n: number }
    ).n;
  }
  private status(row: CommissionRow): CommissionStatus {
    if (row.state === "accepted") return "accepted";
    if (this.unanswered(row.id)) return "awaiting_commissioner";
    if (row.proposal_pending) return "needs_review";
    return row.state;
  }
  private result(id: string): MutationResult {
    return { commissionId: id, status: this.status(this.row(id)) };
  }
  exists(id: string): boolean {
    return this.db.prepare("SELECT 1 FROM commissions WHERE id=?").get(id) !== undefined;
  }
  /** Records the commission and its handoff together, so a handoff is never lost or requested twice. */
  open(
    commissioner: Commissioner,
    input: {
      commissionId: string;
      spec: CommissionSpec;
      workReference: WorkReference;
      connectorId: string;
      binding: WorkerBinding;
    },
  ): MutationResult {
    const { commissionId, spec, workReference, connectorId, binding } = input;
    const fingerprint = { commissioner, spec, workReference, connectorId };
    if (this.exists(commissionId)) {
      this.owned(commissioner, commissionId);
      return this.operation(commissionId, "open", commissioner.id, fingerprint, () =>
        fail("conflict", "This commission was opened with different input"),
      );
    }
    return this.db
      .transaction(() => {
        this.db
          .prepare(
            "INSERT INTO commissions(id,owner,conversation,spec,work_reference,connector_id,binding,state,updated,heartbeat) VALUES(?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            commissionId,
            commissioner.id,
            canonical(commissioner.conversation),
            canonical(spec),
            canonical(workReference),
            connectorId,
            canonical(binding),
            "working",
            this.now(),
            this.now(),
          );
        const result = this.result(commissionId);
        this.db
          .prepare("INSERT INTO operations VALUES(?,?,?,?)")
          .run(
            commissionId,
            "open",
            hash({ actor: commissioner.id, input: fingerprint }),
            canonical(result),
          );
        this.event(commissionId, "open", commissioner.id, "opened", { spec }, false);
        this.event(commissionId, "handoff", commissioner.id, "handoff", {}, true);
        return result;
      })
      .immediate();
  }
  consult(input: QuestionInput): QuestionView {
    const key = `question:${input.questionId}`;
    this.operation(input.commissionId, key, WORKER, input, () => {
      const row = this.row(input.commissionId);
      if (row.state === "accepted") fail("conflict", "The commission is already accepted");
      this.db
        .prepare("INSERT INTO questions(commission_id,id,question) VALUES(?,?,?)")
        .run(row.id, input.questionId, canonical(input.question));
      this.touch(row.id, true);
      this.event(
        row.id,
        key,
        WORKER,
        "question",
        { questionId: input.questionId, question: input.question },
        true,
      );
      return { questionId: input.questionId };
    });
    return this.question(input.commissionId, input.questionId);
  }
  private question(id: string, questionId: string): QuestionView {
    const row = this.db
      .prepare("SELECT question,answer FROM questions WHERE commission_id=? AND id=?")
      .get(id, questionId) as { question: string; answer: string | null } | undefined;
    if (!row) fail("not_found", "Question not found");
    const question = JSON.parse(row.question) as QuestionInput["question"];
    return row.answer === null
      ? { questionId, question, status: "pending" }
      : { questionId, question, status: "answered", answer: JSON.parse(row.answer) as string };
  }
  report(input: ReportInput): MutationResult {
    return this.operation(input.commissionId, `event:${input.eventId}`, WORKER, input, () => {
      const row = this.row(input.commissionId);
      if (row.state === "accepted") fail("conflict", "The commission is already accepted");
      if (input.kind === "proposal") {
        if (row.proposal_pending || this.unanswered(row.id))
          fail("conflict", "Settle pending questions and the prior proposal before proposing");
        this.db
          .prepare("UPDATE commissions SET proposal_id=?,proposal_pending=1 WHERE id=?")
          .run(input.eventId, row.id);
      } else {
        // A checkpoint is the worker saying active work has resumed; a failure says it's blocked.
        this.db
          .prepare("UPDATE commissions SET state=? WHERE id=?")
          .run(input.kind === "failure" ? "blocked" : "working", row.id);
      }
      this.touch(row.id, true);
      this.event(
        row.id,
        `event:${input.eventId}`,
        WORKER,
        input.kind,
        { eventId: input.eventId, data: input.data },
        input.kind !== "checkpoint",
      );
      return this.result(row.id);
    });
  }
  decide(commissioner: Commissioner, input: DecisionInput): MutationResult {
    this.owned(commissioner, input.commissionId);
    return this.operation(
      input.commissionId,
      `event:${input.eventId}`,
      commissioner.id,
      input,
      () => {
        const row = this.row(input.commissionId);
        if (row.state === "accepted") fail("conflict", "The commission is already accepted");
        if (input.target === "question") {
          const question = this.db
            .prepare("SELECT answer FROM questions WHERE commission_id=? AND id=?")
            .get(row.id, input.questionId) as { answer: string | null } | undefined;
          if (!question) fail("not_found", "Question not found in this commission");
          if (question.answer !== null) fail("conflict", "That question is already answered");
          this.db
            .prepare("UPDATE questions SET answer=? WHERE commission_id=? AND id=?")
            .run(canonical(input.decision.answer), row.id, input.questionId);
        } else {
          if (!row.proposal_pending || row.proposal_id !== input.proposalId)
            fail("stale_proposal", "Decide the current pending proposal");
          if (this.unanswered(row.id))
            fail("conflict", "Answer pending questions before deciding the proposal");
          this.db
            .prepare("UPDATE commissions SET proposal_pending=0,state=? WHERE id=?")
            .run(input.decision.verdict === "accept" ? "accepted" : "revision_requested", row.id);
        }
        this.touch(row.id, false);
        this.event(row.id, `event:${input.eventId}`, commissioner.id, "decision", input, false);
        return this.result(row.id);
      },
    );
  }
  /** The worker's view, and the owner's once `commissioner` has been checked against the commission. */
  read(id: string, after = 0, commissioner?: Commissioner): CommissionView {
    const row = commissioner ? this.owned(commissioner, id) : this.row(id);
    const events = (
      this.db
        .prepare(
          "SELECT seq,id,kind,payload,created FROM events WHERE commission_id=? AND seq>? ORDER BY seq LIMIT 100",
        )
        .all(id, after) as {
        seq: number;
        id: string;
        kind: string;
        payload: string;
        created: number;
      }[]
    ).map((event) => ({
      cursor: event.seq,
      eventId: event.id,
      kind: event.kind,
      payload: JSON.parse(event.payload) as unknown,
      createdAt: event.created,
    }));
    const proposal = row.proposal_id
      ? (this.db
          .prepare("SELECT payload FROM events WHERE commission_id=? AND id=? AND kind='proposal'")
          .get(id, `event:${row.proposal_id}`) as { payload: string })
      : undefined;
    const handoff = this.db
      .prepare(
        "SELECT delivered,failure_class FROM outbox WHERE commission_id=? AND event_id='handoff'",
      )
      .get(id) as { delivered: number; failure_class: OutboxFailureClass | null };
    const overdue = this.db
      .prepare(`SELECT 1 FROM commissions c WHERE c.id=? AND ${overdueEligibility}`)
      .get(id, this.now() - this.overdueAfterMs);
    const questions = this.db
      .prepare("SELECT id FROM questions WHERE commission_id=? ORDER BY rowid")
      .all(id) as { id: string }[];
    return {
      commissionId: id,
      status: this.status(row),
      spec: JSON.parse(row.spec) as CommissionSpec,
      workReference: JSON.parse(row.work_reference) as WorkReference,
      handoff: {
        status: handoff.delivered ? "confirmed" : "pending",
        lastFailure: handoff.delivered ? null : handoff.failure_class,
      },
      currentProposal:
        proposal && row.proposal_id
          ? {
              proposalId: row.proposal_id,
              pending: Boolean(row.proposal_pending),
              ...(
                JSON.parse(proposal.payload) as {
                  data: { summary: string; artifact: ArtifactReference };
                }
              ).data,
            }
          : null,
      questions: questions.map((question) => this.question(id, question.id)),
      events,
      nextCursor: events.at(-1)?.cursor ?? after,
      ...(overdue
        ? { attention: { kind: "overdue_checkpoint" as const, lastWorkerActivity: row.heartbeat } }
        : {}),
    };
  }
  /** What the dispatcher needs for one entry: the owner's conversation, and the worker binding for a handoff. */
  delivery(id: string): {
    owner: string;
    conversation: Conversation;
    spec: CommissionSpec;
    connectorId: string;
    binding: WorkerBinding;
  } {
    const row = this.row(id);
    return {
      owner: row.owner,
      conversation: JSON.parse(row.conversation) as Conversation,
      spec: JSON.parse(row.spec) as CommissionSpec,
      connectorId: row.connector_id,
      binding: JSON.parse(row.binding) as WorkerBinding,
    };
  }
  /** One notice per quiet spell: a new one only after the worker or the commissioner acts again. */
  reconcileOverdue(batchLimit = 100): number {
    return this.db
      .transaction(() => {
        const rows = this.db
          .prepare(`SELECT * FROM commissions c WHERE ${overdueEligibility}
        AND NOT EXISTS (SELECT 1 FROM events e WHERE e.commission_id=c.id AND e.id='overdue:' || max(c.updated,c.heartbeat))
        ORDER BY max(c.updated,c.heartbeat),id LIMIT ?`)
          .all(this.now() - this.overdueAfterMs, batchLimit) as CommissionRow[];
        for (const row of rows)
          this.event(
            row.id,
            `overdue:${Math.max(row.updated, row.heartbeat)}`,
            "commissioning",
            "overdue_checkpoint",
            { lastWorkerActivity: row.heartbeat },
            true,
          );
        return rows.length;
      })
      .immediate();
  }
  /**
   * Entries due for delivery, fewest attempts first, so entries that keep failing can't hold back newer ones.
   * Nothing is leased here; the dispatcher claims each entry just before sending it.
   */
  pendingOutbox(batchLimit = 100): number[] {
    return (
      this.db
        .prepare(`SELECT seq FROM outbox WHERE delivered=0 AND (lease_until IS NULL OR lease_until<=?)
      ORDER BY attempt_count,seq LIMIT ?`)
        .all(this.now(), batchLimit) as { seq: number }[]
    ).map((row) => row.seq);
  }
  /** Claims one entry if it's still due; another process holding a live lease keeps it. */
  claimOutbox(seq: number, leaseMs = 120_000): OutboxEntry | undefined {
    return this.db
      .transaction(() => {
        const now = this.now();
        const token = randomUUID();
        const changed = this.db
          .prepare(`UPDATE outbox SET lease_token=?,lease_until=?,attempt_count=attempt_count+1
        WHERE seq=? AND delivered=0 AND (lease_until IS NULL OR lease_until<=?)`)
          .run(token, now + leaseMs, seq, now);
        if (!changed.changes) return undefined;
        const row = this.db.prepare("SELECT * FROM outbox WHERE seq=?").get(seq) as OutboxRow;
        return {
          seq: row.seq,
          commissionId: row.commission_id,
          eventId: row.event_id,
          kind: row.kind,
          payload: JSON.parse(row.payload) as unknown,
          leaseToken: token,
        };
      })
      .immediate();
  }
  acknowledgeOutbox(seq: number, leaseToken: string): void {
    this.finishLease(seq, leaseToken, null);
  }
  releaseOutbox(seq: number, leaseToken: string, failure: OutboxFailureClass): void {
    this.finishLease(seq, leaseToken, failure);
  }
  private finishLease(seq: number, leaseToken: string, failure: OutboxFailureClass | null): void {
    const result =
      failure === null
        ? this.db
            .prepare(
              "UPDATE outbox SET delivered=1,failure_class=NULL WHERE seq=? AND lease_token=? AND lease_until>?",
            )
            .run(seq, leaseToken, this.now())
        : this.db
            .prepare(
              "UPDATE outbox SET lease_token=NULL,lease_until=NULL,failure_class=? WHERE seq=? AND lease_token=? AND lease_until>?",
            )
            .run(failure, seq, leaseToken, this.now());
    if (!result.changes) fail("lease_lost", "The outbox lease expired or was replaced");
  }
}
