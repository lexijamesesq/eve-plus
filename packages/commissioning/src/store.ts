import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type {
  Caller,
  CommissionErrorCode,
  CommissionerContext,
  CommissionSource,
  CommissionSpec,
  CommissionStatus,
  CommissionView,
  DecisionInput,
  MutationResult,
  OpenInput,
  OutboxEntry,
  OutboxFailureClass,
  PendingWork,
  QuestionInput,
  QuestionView,
  RebindSessionInput,
  RebindSessionResult,
  ReportInput,
  StoreOptions,
} from "./types.js";

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
function object(
  value: unknown,
  keys: string[],
  required = keys,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("invalid_input", "Expected an object");
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !keys.includes(key)) ||
    required.some((key) => !Object.hasOwn(record, key))
  )
    fail("invalid_input", "Missing or unsupported input field");
}
function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 100_000)
    fail("invalid_input", "Expected nonempty bounded text");
}
function identifier(value: unknown): asserts value is string {
  text(value);
  if (value.length > 256 || Array.from(value).some((character) => character.charCodeAt(0) < 32))
    fail("invalid_input", "Invalid identifier");
}
function caller(value: Caller): void {
  if (value?.verified !== true) fail("unverified_caller", "A host-verified caller is required");
  identifier(value.principalId);
}
/** Stable, recursive JSON representation: object key ordering cannot change an operation's identity. */
function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return fail("invalid_input", "Inputs must contain JSON values only");
}
function hash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function limit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 100)
    fail("invalid_input", "Batch limit must be from 1 to 100");
  return value;
}
function spec(value: CommissionSpec): void {
  object(value, ["brief", "acceptance", "privateGuidance"], ["brief", "acceptance"]);
  text(value.brief);
  if (
    !Array.isArray(value.acceptance) ||
    value.acceptance.length < 1 ||
    value.acceptance.length > 100
  )
    fail("invalid_input", "Acceptance criteria are required");
  value.acceptance.forEach(text);
  if (Object.hasOwn(value, "privateGuidance")) text(value.privateGuidance);
}
function source(value: unknown): asserts value is CommissionSource {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("invalid_input", "Invalid commission source");
  const entries = Object.entries(value);
  if (!entries.length || entries.length > 16)
    fail("invalid_input", "Commission source must have 1 to 16 fields");
  for (const [key, item] of entries) {
    identifier(key);
    text(item);
    if (key.length > 64 || item.length > 1024)
      fail("invalid_input", "Commission source field exceeds bounds");
  }
}
function artifact(value: unknown): void {
  object(value, ["repository", "commit", "pullRequest"]);
  text(value.repository);
  text(value.commit);
  text(value.pullRequest);
  if (!/^[a-f0-9]{40}$/.test(value.commit))
    fail("invalid_input", "Artifact commit must be a full lowercase 40-hex commit");
  let repository: URL;
  let pullRequest: URL;
  try {
    repository = new URL(value.repository);
    pullRequest = new URL(value.pullRequest);
  } catch {
    fail("invalid_input", "Artifact references must be HTTPS repository and pull request URLs");
  }
  if (
    repository.protocol !== "https:" ||
    pullRequest.protocol !== "https:" ||
    repository.username ||
    repository.password ||
    pullRequest.username ||
    pullRequest.password ||
    repository.search ||
    repository.hash ||
    pullRequest.search ||
    pullRequest.hash
  )
    fail(
      "invalid_input",
      "Artifact references must be credential-free HTTPS URLs without queries or fragments",
    );
  const repoPath = repository.pathname.replace(/\.git$/, "").replace(/\/$/, "");
  if (
    !repoPath ||
    repoPath === "/" ||
    pullRequest.origin !== repository.origin ||
    !new RegExp(
      `^${repoPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(?:pull|merge_requests|-/merge_requests)/[1-9][0-9]*/?$`,
    ).test(pullRequest.pathname)
  )
    fail("invalid_input", "Pull request must belong to the artifact repository");
}
interface CommissionRow {
  id: string;
  owner: string;
  worker: string;
  spec: string;
  state: "working" | "revision_requested" | "blocked" | "accepted";
  proposal_id: string | null;
  proposal_pending: number;
  updated: number;
  heartbeat: number;
}
interface QuestionRow {
  id: string;
  question: string;
  answer: string | null;
}
interface OutboxRow {
  seq: number;
  commission_id: string;
  event_id: string;
  recipient: string;
  kind: string;
  payload: string;
  lease_token: string | null;
  attempt_count: number;
}

/** One persistent SQLite mount, one host dispatcher. Leases recover receipts lost across process restarts. */
export class CommissionStore {
  private readonly db: Database.Database;
  private readonly now: () => number;
  private readonly overdueAfterMs: number;
  constructor(path: string, options: StoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.overdueAfterMs = options.overdueAfterMs ?? 60_000;
    if (!Number.isFinite(this.overdueAfterMs) || this.overdueAfterMs <= 0)
      fail("invalid_input", "overdueAfterMs must be positive");
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    try {
      this.db.pragma("foreign_keys = ON");
      this.db.pragma("busy_timeout = 5000");
      const version = this.db.pragma("user_version", { simple: true }) as number;
      if (version !== 0 && version !== 1 && version !== 2)
        fail("unsupported_schema", `Unsupported commissioning schema version ${version}`);
      if (version === 0)
        this.db
          .transaction(() => {
            const tables = this.db
              .prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
              )
              .all();
            if (tables.length)
              fail(
                "unsupported_schema",
                "Unversioned nonempty database cannot be migrated automatically",
              );
            this.db.exec(`
          CREATE TABLE commissions(id TEXT PRIMARY KEY,owner TEXT NOT NULL,worker TEXT NOT NULL,spec TEXT NOT NULL,
            state TEXT NOT NULL,proposal_id TEXT,proposal_pending INTEGER NOT NULL DEFAULT 0,updated INTEGER NOT NULL,heartbeat INTEGER NOT NULL);
          CREATE TABLE contexts(commission_id TEXT PRIMARY KEY REFERENCES commissions(id),value TEXT NOT NULL);
          CREATE TABLE questions(commission_id TEXT NOT NULL REFERENCES commissions(id),id TEXT NOT NULL,question TEXT NOT NULL,answer TEXT,
            PRIMARY KEY(commission_id,id));
          CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,commission_id TEXT NOT NULL REFERENCES commissions(id),id TEXT NOT NULL,
            actor TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,created INTEGER NOT NULL,UNIQUE(commission_id,id));
          CREATE TABLE operations(commission_id TEXT NOT NULL REFERENCES commissions(id),id TEXT NOT NULL,hash TEXT NOT NULL,result TEXT NOT NULL,
            PRIMARY KEY(commission_id,id));
          CREATE TABLE delivery(commission_id TEXT NOT NULL REFERENCES commissions(id),proposal_id TEXT NOT NULL,kind TEXT NOT NULL,
            PRIMARY KEY(commission_id,proposal_id,kind));
          CREATE TABLE outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,commission_id TEXT NOT NULL REFERENCES commissions(id),event_id TEXT NOT NULL,
            recipient TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,delivered INTEGER NOT NULL DEFAULT 0,lease_token TEXT,lease_until INTEGER,
            attempt_count INTEGER NOT NULL DEFAULT 0,last_attempt_at INTEGER,failure_class TEXT,
            UNIQUE(commission_id,event_id));
          CREATE INDEX outbox_pending ON outbox(delivered,lease_until,seq);
          PRAGMA user_version=2;
        `);
          })
          .immediate();
      if (version === 1)
        this.db
          .transaction(() => {
            this.db.exec(`ALTER TABLE outbox ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE outbox ADD COLUMN last_attempt_at INTEGER;
          ALTER TABLE outbox ADD COLUMN failure_class TEXT;
          PRAGMA user_version=2;`);
          })
          .immediate();
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
  private row(id: string): CommissionRow | undefined {
    return this.db.prepare("SELECT * FROM commissions WHERE id=?").get(id) as
      | CommissionRow
      | undefined;
  }
  private requireRow(id: string): CommissionRow {
    return this.row(id) ?? fail("not_found", "Commission not found");
  }
  private authorized(actor: Caller, id: string, role?: "owner" | "worker"): CommissionRow {
    caller(actor);
    identifier(id);
    const row = this.row(id);
    if (!row || ![row.owner, row.worker].includes(actor.principalId))
      fail("not_found", "Commission not found or unavailable to this caller");
    if (role && row[role] !== actor.principalId)
      fail("forbidden", `Only the assigned ${role} may perform this operation`);
    return row;
  }
  private operation<T>(
    actor: Caller,
    id: string,
    eventId: string,
    input: unknown,
    execute: () => T,
  ): T {
    return this.db
      .transaction(() => {
        const digest = hash({ actor: actor.principalId, input });
        const previous = this.db
          .prepare("SELECT hash,result FROM operations WHERE commission_id=? AND id=?")
          .get(id, eventId) as { hash: string; result: string } | undefined;
        if (previous) {
          if (previous.hash !== digest)
            fail("conflict", "Event ID was already used with different input");
          return JSON.parse(previous.result) as T;
        }
        const result = execute();
        this.db
          .prepare("INSERT INTO operations VALUES(?,?,?,?)")
          .run(id, eventId, digest, canonical(result));
        return result;
      })
      .immediate();
  }
  private event(
    actor: Caller,
    id: string,
    eventId: string,
    kind: string,
    payload: unknown,
    recipient?: string,
  ): void {
    const encoded = canonical(payload);
    this.db
      .prepare(
        "INSERT INTO events(commission_id,id,actor,kind,payload,created) VALUES(?,?,?,?,?,?)",
      )
      .run(id, eventId, actor.principalId, kind, encoded, this.now());
    if (recipient)
      this.db
        .prepare(
          "INSERT INTO outbox(commission_id,event_id,recipient,kind,payload) VALUES(?,?,?,?,?)",
        )
        .run(id, eventId, recipient, kind, encoded);
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
    return { commissionId: id, status: this.status(this.requireRow(id)) };
  }
  open(
    actor: Caller,
    input: OpenInput,
    worker: Caller,
    context?: CommissionerContext,
  ): MutationResult {
    caller(actor);
    caller(worker);
    object(input, ["commissionId", "spec"]);
    identifier(input.commissionId);
    spec(input.spec);
    if (context !== undefined) {
      object(
        context,
        ["originSessionId", "messages", "source", "initiator"],
        ["originSessionId", "messages"],
      );
      if (context.source !== undefined) source(context.source);
      if (context.initiator !== undefined) {
        object(context.initiator, ["principalId", "authenticator", "principalType"]);
        identifier(context.initiator.principalId);
        identifier(context.initiator.authenticator);
        identifier(context.initiator.principalType);
      }
      identifier(context.originSessionId);
      if (!Array.isArray(context.messages)) fail("invalid_input", "Invalid commissioner messages");
      for (const message of context.messages) {
        object(message, ["role", "content"]);
        if (message.role !== "user" && message.role !== "assistant")
          fail("invalid_input", "Only commissioner conversation text can be captured");
        text(message.content);
      }
      if (Buffer.byteLength(canonical(context)) > 131_072)
        fail("invalid_input", "Commissioner context exceeds 128 KiB");
    }
    if (actor.principalId === worker.principalId)
      fail("forbidden", "The commissioner and assigned worker must be different principals");
    const existing = this.row(input.commissionId);
    if (existing && existing.owner !== actor.principalId)
      fail("not_found", "Commission not found or unavailable to this caller");
    return this.operation(
      actor,
      input.commissionId,
      "open",
      { ...input, worker: worker.principalId, context: context ?? null },
      () => {
        this.db
          .prepare(
            "INSERT INTO commissions(id,owner,worker,spec,state,updated,heartbeat) VALUES(?,?,?,?,?,?,?)",
          )
          .run(
            input.commissionId,
            actor.principalId,
            worker.principalId,
            canonical(input.spec),
            "working",
            this.now(),
            this.now(),
          );
        if (context)
          this.db
            .prepare("INSERT INTO contexts VALUES(?,?)")
            .run(input.commissionId, canonical(context));
        this.event(actor, input.commissionId, "open", "opened", {
          spec: { brief: input.spec.brief, acceptance: input.spec.acceptance },
        });
        return this.result(input.commissionId);
      },
    );
  }
  consult(actor: Caller, input: QuestionInput): QuestionView {
    object(input, ["commissionId", "questionId", "question"]);
    identifier(input.questionId);
    object(input.question, ["text", "options"], ["text"]);
    text(input.question.text);
    if (Object.hasOwn(input.question, "options")) {
      if (!Array.isArray(input.question.options) || input.question.options.length > 100)
        fail("invalid_input", "Invalid question options");
      input.question.options.forEach(text);
    }
    this.authorized(actor, input.commissionId, "worker");
    this.operation(actor, input.commissionId, `question:${input.questionId}`, input, () => {
      const row = this.requireRow(input.commissionId);
      if (row.state === "accepted") fail("conflict", "Commission is already accepted");
      this.db
        .prepare("INSERT INTO questions(commission_id,id,question) VALUES(?,?,?)")
        .run(input.commissionId, input.questionId, canonical(input.question));
      this.db
        .prepare("UPDATE commissions SET updated=?,heartbeat=? WHERE id=?")
        .run(this.now(), this.now(), input.commissionId);
      this.event(
        actor,
        input.commissionId,
        `question:${input.questionId}`,
        "question",
        { questionId: input.questionId, question: input.question },
        row.owner,
      );
      return { questionId: input.questionId };
    });
    return this.question(actor, input.commissionId, input.questionId);
  }
  question(actor: Caller, id: string, questionId: string): QuestionView {
    this.authorized(actor, id);
    identifier(questionId);
    const row = this.db
      .prepare("SELECT * FROM questions WHERE commission_id=? AND id=?")
      .get(id, questionId) as QuestionRow | undefined;
    if (!row) fail("not_found", "Question not found");
    const base = {
      commissionId: id,
      questionId,
      question: JSON.parse(row.question) as QuestionInput["question"],
    };
    return row.answer === null
      ? { ...base, status: "pending" }
      : { ...base, status: "answered", answer: JSON.parse(row.answer) as { answer: string } };
  }
  report(actor: Caller, input: ReportInput): MutationResult {
    object(input, ["commissionId", "eventId", "kind", "data"]);
    identifier(input.eventId);
    if (
      !["proposal", "checkpoint", "failure", "reviewed", "merged", "deployed"].includes(input.kind)
    )
      fail("invalid_input", "Unsupported report kind");
    object(
      input.data,
      input.kind === "proposal"
        ? ["summary", "artifact"]
        : ["reviewed", "merged", "deployed"].includes(input.kind)
          ? ["summary", "proposalId"]
          : ["summary"],
    );
    text(input.data.summary);
    if (input.kind === "proposal") artifact(input.data.artifact);
    else if (input.kind !== "checkpoint" && input.kind !== "failure")
      identifier(input.data.proposalId);
    this.authorized(actor, input.commissionId, "worker");
    return this.operation(actor, input.commissionId, `event:${input.eventId}`, input, () => {
      const row = this.requireRow(input.commissionId);
      if (input.kind === "proposal") {
        if (row.state === "accepted" || row.proposal_pending || this.unanswered(row.id))
          fail("conflict", "Settle pending questions and the prior proposal before proposing");
        this.db
          .prepare("UPDATE commissions SET proposal_id=?,proposal_pending=1 WHERE id=?")
          .run(input.eventId, row.id);
      } else if (input.kind === "checkpoint" || input.kind === "failure") {
        if (row.state === "accepted") fail("conflict", "Commission is already accepted");
        // A checkpoint is the worker's explicit statement that active work has resumed.
        this.db
          .prepare("UPDATE commissions SET state=? WHERE id=?")
          .run(input.kind === "failure" ? "blocked" : "working", row.id);
      } else {
        if (row.proposal_id !== input.data.proposalId)
          fail("stale_proposal", "Delivery observation must refer to the current proposal");
        this.db
          .prepare("INSERT OR IGNORE INTO delivery VALUES(?,?,?)")
          .run(row.id, input.data.proposalId, input.kind);
      }
      this.db
        .prepare("UPDATE commissions SET updated=?,heartbeat=? WHERE id=?")
        .run(this.now(), this.now(), row.id);
      this.event(
        actor,
        row.id,
        `event:${input.eventId}`,
        input.kind,
        { eventId: input.eventId, data: input.data },
        input.kind === "proposal" || input.kind === "failure" ? row.owner : undefined,
      );
      return this.result(row.id);
    });
  }
  decide(actor: Caller, input: DecisionInput): MutationResult {
    object(
      input,
      input.target === "question"
        ? ["commissionId", "eventId", "target", "questionId", "decision"]
        : ["commissionId", "eventId", "target", "proposalId", "decision"],
    );
    identifier(input.eventId);
    if (input.target === "question") {
      identifier(input.questionId);
      object(input.decision, ["answer"]);
      text(input.decision.answer);
    } else if (input.target === "proposal") {
      identifier(input.proposalId);
      object(input.decision, ["verdict", "feedback"]);
      text(input.decision.feedback);
      if (input.decision.verdict !== "accept" && input.decision.verdict !== "revise")
        fail("invalid_input", "Unsupported verdict");
    } else fail("invalid_input", "Unsupported decision target");
    this.authorized(actor, input.commissionId, "owner");
    return this.operation(actor, input.commissionId, `event:${input.eventId}`, input, () => {
      const row = this.requireRow(input.commissionId);
      if (row.state === "accepted") fail("conflict", "Commission is already accepted");
      if (input.target === "question") {
        const question = this.db
          .prepare("SELECT answer FROM questions WHERE commission_id=? AND id=?")
          .get(row.id, input.questionId) as { answer: string | null } | undefined;
        if (!question) fail("not_found", "Question not found in this commission");
        if (question.answer !== null) fail("conflict", "Question already has a decision");
        this.db
          .prepare("UPDATE questions SET answer=? WHERE commission_id=? AND id=?")
          .run(canonical(input.decision), row.id, input.questionId);
      } else {
        if (!row.proposal_pending || row.proposal_id !== input.proposalId)
          fail("stale_proposal", "Decision must refer to the current pending proposal");
        if (this.unanswered(row.id))
          fail("conflict", "Answer pending questions before deciding the proposal");
        this.db
          .prepare("UPDATE commissions SET proposal_pending=0,state=? WHERE id=?")
          .run(input.decision.verdict === "accept" ? "accepted" : "revision_requested", row.id);
      }
      this.db.prepare("UPDATE commissions SET updated=? WHERE id=?").run(this.now(), row.id);
      this.event(actor, row.id, `event:${input.eventId}`, "decision", input);
      return this.result(row.id);
    });
  }
  read(actor: Caller, id: string, after = 0): CommissionView {
    const row = this.authorized(actor, id);
    if (!Number.isSafeInteger(after) || after < 0) fail("invalid_input", "Invalid event cursor");
    const publicSpec = JSON.parse(row.spec) as CommissionSpec;
    if (actor.principalId !== row.owner) delete publicSpec.privateGuidance;
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
      payload:
        actor.principalId !== row.owner && event.kind === "session_rebound"
          ? { redacted: true }
          : (JSON.parse(event.payload) as unknown),
      createdAt: event.created,
    }));
    const observations = new Set(
      (
        this.db
          .prepare("SELECT kind FROM delivery WHERE commission_id=? AND proposal_id=?")
          .all(id, row.proposal_id) as { kind: string }[]
      ).map((value) => value.kind),
    );
    const status = this.status(row);
    const proposal = row.proposal_id
      ? (this.db
          .prepare("SELECT payload FROM events WHERE commission_id=? AND id=? AND kind='proposal'")
          .get(id, `event:${row.proposal_id}`) as { payload: string } | undefined)
      : undefined;
    const proposalData = proposal
      ? (
          JSON.parse(proposal.payload) as {
            data: { summary: string; artifact: import("./types.js").ArtifactReference };
          }
        ).data
      : undefined;
    const notification =
      actor.principalId === row.owner
        ? (this.db
            .prepare(
              "SELECT count(CASE WHEN delivered=0 THEN 1 END) AS pending,coalesce(sum(attempt_count),0) AS attemptCount,max(last_attempt_at) AS lastAttemptAt FROM outbox WHERE commission_id=?",
            )
            .get(id) as { pending: number; attemptCount: number; lastAttemptAt: number | null })
        : undefined;
    const failure =
      actor.principalId === row.owner
        ? (this.db
            .prepare(
              "SELECT failure_class AS failureClass FROM outbox WHERE commission_id=? AND delivered=0 AND failure_class IS NOT NULL ORDER BY last_attempt_at DESC,seq DESC LIMIT 1",
            )
            .get(id) as { failureClass: OutboxFailureClass } | undefined)
        : undefined;
    return {
      commissionId: id,
      status,
      owner: row.owner,
      worker: row.worker,
      spec: publicSpec,
      proposalId: row.proposal_id,
      proposalPending: Boolean(row.proposal_pending),
      currentProposal:
        proposalData && row.proposal_id ? { proposalId: row.proposal_id, ...proposalData } : null,
      ...(notification
        ? { notification: { ...notification, failureClass: failure?.failureClass ?? null } }
        : {}),
      delivery: {
        reviewed: observations.has("reviewed"),
        merged: observations.has("merged"),
        deployed: observations.has("deployed"),
      },
      questions: (
        this.db
          .prepare("SELECT id FROM questions WHERE commission_id=? ORDER BY rowid")
          .all(id) as { id: string }[]
      ).map((value) => this.question(actor, id, value.id)),
      events,
      nextCursor: events.at(-1)?.cursor ?? after,
      ...(status === "working" && this.now() - row.heartbeat > this.overdueAfterMs
        ? { attention: { kind: "overdue_checkpoint" as const, lastWorkerActivity: row.heartbeat } }
        : {}),
    };
  }
  pending(actor: Caller, batchLimit = 100): PendingWork[] {
    caller(actor);
    limit(batchLimit);
    return this.db
      .prepare(`SELECT c.id AS commissionId,'question' AS kind,q.id AS id,c.owner,c.worker FROM questions q JOIN commissions c ON q.commission_id=c.id
      WHERE q.answer IS NULL AND c.owner=? UNION ALL SELECT id AS commissionId,'proposal' AS kind,proposal_id AS id,owner,worker FROM commissions
      WHERE proposal_pending=1 AND owner=? ORDER BY commissionId,kind,id LIMIT ?`)
      .all(actor.principalId, actor.principalId, batchLimit) as PendingWork[];
  }
  /** Trusted host schedule: one attention event per overdue worker checkpoint, never a dead/failed verdict. */
  reconcileOverdue(batchLimit = 100): number {
    limit(batchLimit);
    return this.db
      .transaction(() => {
        const rows = this.db
          .prepare(`SELECT * FROM commissions c WHERE state='working' AND proposal_pending=0
        AND heartbeat<? AND NOT EXISTS (SELECT 1 FROM questions q WHERE q.commission_id=c.id AND q.answer IS NULL)
        AND NOT EXISTS (SELECT 1 FROM events e WHERE e.commission_id=c.id AND e.id='overdue:' || c.heartbeat)
        ORDER BY heartbeat,id LIMIT ?`)
          .all(this.now() - this.overdueAfterMs, batchLimit) as CommissionRow[];
        for (const row of rows) {
          this.event(
            { principalId: "commissioning:reconciler", verified: true },
            row.id,
            `overdue:${row.heartbeat}`,
            "overdue_checkpoint",
            { lastWorkerActivity: row.heartbeat },
            row.owner,
          );
        }
        return rows.length;
      })
      .immediate();
  }
  /** Explicit trusted-host recovery only. The host derives source, new session and requestedBy from authenticated context. */
  rebindSession(
    owner: Caller,
    input: RebindSessionInput,
    requestedBy: Caller,
  ): RebindSessionResult {
    this.authorized(owner, input.commissionId, "owner");
    caller(requestedBy);
    object(input, [
      "commissionId",
      "eventId",
      "expectedActiveSessionId",
      "activeSessionId",
      "source",
    ]);
    identifier(input.eventId);
    identifier(input.expectedActiveSessionId);
    identifier(input.activeSessionId);
    source(input.source);
    return this.operation(
      owner,
      input.commissionId,
      `event:${input.eventId}`,
      { ...input, requestedBy: requestedBy.principalId },
      () => {
        const context = this.context(input.commissionId);
        if (!context?.source || canonical(context.source) !== canonical(input.source))
          fail("forbidden", "Rebind requires the original captured source");
        const priorSessionId = context.activeSessionId ?? context.originSessionId;
        if (priorSessionId !== input.expectedActiveSessionId)
          fail("conflict", "Commission session changed since recovery was requested");
        this.db
          .prepare("UPDATE contexts SET value=? WHERE commission_id=?")
          .run(
            canonical({ ...context, activeSessionId: input.activeSessionId }),
            input.commissionId,
          );
        this.event(requestedBy, input.commissionId, `event:${input.eventId}`, "session_rebound", {
          priorSessionId,
          activeSessionId: input.activeSessionId,
          requestedByPrincipalId: requestedBy.principalId,
        });
        return { commissionId: input.commissionId, activeSessionId: input.activeSessionId };
      },
    );
  }
  /** Trusted host only: this method is never registered as a worker tool. */
  context(id: string): CommissionerContext | undefined {
    identifier(id);
    const row = this.db.prepare("SELECT value FROM contexts WHERE commission_id=?").get(id) as
      | { value: string }
      | undefined;
    return row ? (JSON.parse(row.value) as CommissionerContext) : undefined;
  }
  claimOutbox(input: {
    consumerId: string;
    limit?: number;
    leaseMs?: number;
    afterSeq?: number;
  }): OutboxEntry[] {
    identifier(input.consumerId);
    const batchLimit = limit(input.limit ?? 100);
    const leaseMs = input.leaseMs ?? 30_000;
    const afterSeq = input.afterSeq ?? 0;
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0)
      fail("invalid_input", "Invalid outbox cursor");
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 300_000)
      fail("invalid_input", "Lease must be from 1 to 300000 milliseconds");
    return this.db
      .transaction(() => {
        const now = this.now();
        const rows = this.db
          .prepare(
            "SELECT * FROM outbox WHERE delivered=0 AND seq>? AND (lease_until IS NULL OR lease_until<=?) ORDER BY seq LIMIT ?",
          )
          .all(afterSeq, now, batchLimit) as OutboxRow[];
        return rows.map((row) => {
          const token = `${input.consumerId}:${randomUUID()}`;
          this.db
            .prepare(
              "UPDATE outbox SET lease_token=?,lease_until=?,attempt_count=attempt_count+1,last_attempt_at=? WHERE seq=?",
            )
            .run(token, now + leaseMs, now, row.seq);
          return {
            seq: row.seq,
            commissionId: row.commission_id,
            eventId: row.event_id,
            recipient: row.recipient,
            kind: row.kind,
            payload: JSON.parse(row.payload) as unknown,
            leaseToken: token,
            attemptCount: row.attempt_count + 1,
            lastAttemptAt: now,
          };
        });
      })
      .immediate();
  }
  acknowledgeOutbox(seq: number, leaseToken: string): void {
    this.finishLease(seq, leaseToken, true);
  }
  releaseOutbox(
    seq: number,
    leaseToken: string,
    failureClass: OutboxFailureClass = "dispatch_failed",
  ): void {
    if (failureClass !== "identity_unavailable" && failureClass !== "dispatch_failed")
      fail("invalid_input", "Invalid outbox failure class");
    this.finishLease(seq, leaseToken, false, failureClass);
  }
  private finishLease(
    seq: number,
    leaseToken: string,
    delivered: boolean,
    failureClass?: OutboxFailureClass,
  ): void {
    if (!Number.isSafeInteger(seq) || seq < 1) fail("invalid_input", "Invalid outbox sequence");
    text(leaseToken);
    const result = this.db
      .prepare(
        delivered
          ? "UPDATE outbox SET delivered=1,failure_class=NULL WHERE seq=? AND lease_token=? AND lease_until>?"
          : "UPDATE outbox SET lease_token=NULL,lease_until=NULL,failure_class=? WHERE seq=? AND lease_token=? AND lease_until>?",
      )
      .run(
        ...(delivered
          ? [seq, leaseToken, this.now()]
          : [failureClass, seq, leaseToken, this.now()]),
      );
    if (!result.changes) fail("lease_lost", "Outbox lease expired or was replaced");
  }
}
