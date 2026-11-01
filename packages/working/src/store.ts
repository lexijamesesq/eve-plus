// The working store: loops, orders and notes in one SQLite file per agent, with every change kept as an attributed
// event. Closing a loop or lifting an order is an event, never a deletion. The host's wake engine drives loops' wakes
// through claimDue / settleWake / eventOccurred; delivery stays with the host, which knows its channels. A delivery
// that fails isn't settled: its lease runs out and the next tick claims it again.

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SessionAuthContext } from "eve/context";
import { z } from "zod";

import { type Address, addressKey } from "./addresses.js";

export { type Address, addressKey } from "./addresses.js";

/** Who a write came from, by the kind of turn that made it. The host classifies; the package never asks the model. */
export type OriginKind = "operator" | "colleague" | "scheduled" | "webhook" | "delegated" | "other";

/** The attribution every write records, from eve's session and tool context. */
export interface Origin {
  readonly principalId: string | null;
  readonly kind: OriginKind;
  readonly sessionId: string | null;
  readonly turnId?: string;
  readonly callId?: string;
}

export type LoopStatus = "open" | "delivering" | "done" | "dropped";
export type OrderStatus = "active" | "lifted" | "replaced";
/** A loop's wake: due on its time or event, or recorded where the host can't hand off and shown as due instead. */
export type WakeState = "pending" | "undeliverable";

export interface Loop {
  readonly id: string;
  readonly kind: "loop";
  readonly status: LoopStatus;
  readonly conversationKey: string;
  readonly address: Address;
  readonly what: string;
  readonly waitingOn: string;
  readonly next: string;
  readonly links: readonly string[];
  readonly signature: string | null;
  readonly dueAt: number | null;
  readonly onEvent: string | null;
  readonly wake: WakeState | null;
  readonly firedBy: string | null;
  readonly why: string | null;
  readonly followupNote: string;
  readonly reviewBy: number;
  readonly origin: Origin;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface Order {
  readonly id: string;
  readonly kind: "order";
  readonly status: OrderStatus;
  readonly subject: string;
  readonly rule: string;
  readonly link: string;
  readonly until: number | null;
  readonly why: string | null;
  readonly reviewBy: number;
  readonly origin: Origin;
  /** Who lifted or replaced it, once it isn't active. */
  readonly endedBy: Origin | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface Note {
  readonly id: string;
  readonly kind: "note";
  readonly status: "active" | "expired";
  readonly text: string;
  readonly expiresAt: number;
  readonly origin: Origin;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type Entry = Loop | Order | Note;

export type Row = Record<string, string | number | null>;

/** One recorded change to an entry. `before` and `after` are its stored row. */
export interface EntryEvent {
  readonly seq: number;
  readonly entryKind: Entry["kind"];
  readonly entryId: string;
  readonly change: string;
  readonly before: Row | null;
  readonly after: Row | null;
  readonly origin: Origin;
  readonly at: number;
}

/** A loop leased for delivery. Only the holder of `leaseToken` can settle or release it. */
export interface ClaimedLoop {
  readonly id: string;
  readonly address: Address;
  readonly conversationKey: string;
  /** The opening turn's session auth, for the host to send the wake as. Attribution is `Loop.origin`'s. */
  readonly principal: SessionAuthContext | null;
  readonly followupNote: string;
  readonly dueAt: number | null;
  readonly onEvent: string | null;
  readonly firedBy: string | null;
  readonly leaseToken: string;
  readonly createdAt: number;
}

export interface Revisit {
  readonly dueAt?: number;
  readonly onEvent?: string;
}

export interface OpenInput {
  readonly address: Address;
  /** The opening turn's session auth, kept for the wake. */
  readonly principal: SessionAuthContext | null;
  readonly what: string;
  readonly waitingOn: string;
  readonly next: string;
  readonly links?: readonly string[];
  readonly signature?: string;
  readonly reviewBy?: number;
  readonly revisit?: Revisit;
  /** False when the host can't hand a wake off at this address: the wake is kept as undeliverable. */
  readonly deliverable?: boolean;
}

export interface UpdateInput {
  readonly next?: string;
  readonly waitingOn?: string;
  readonly links?: readonly string[];
  /** null removes the wake. */
  readonly revisit?: Revisit | null;
  readonly deliverable?: boolean;
  readonly reviewBy?: number;
}

export type Refusal = { readonly ok: false; readonly reason: string };
export type Result<T> = ({ readonly ok: true } & T) | Refusal;

export type ListView = "here" | "elsewhere" | "orders" | "stale" | "lifted" | "notes" | "all";
export interface ListFilter {
  readonly view: ListView;
  /** The current conversation's key, for `here` and `elsewhere`; null when the turn has none. */
  readonly conversationKey?: string | null;
  /** Max entries of each kind. Default 50, at most 200. */
  readonly limit?: number;
}

export interface Listing {
  readonly loops: readonly Loop[];
  readonly orders: readonly Order[];
  readonly notes: readonly Note[];
  /** How many of each matched before `limit`. */
  readonly totals: { readonly loops: number; readonly orders: number; readonly notes: number };
}

export interface RevertFilter {
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly callId?: string;
  readonly principalId?: string;
}

export interface MigrationReport {
  readonly imported: number;
  readonly skipped: number;
  readonly unresolved: number;
}

export interface WorkingStoreOptions {
  readonly now?: () => number;
  /** Days before an entry is marked stale. Defaults: loop 7, order 14, note 7 (a note expires then). */
  readonly reviewAfterDays?: {
    readonly loop?: number;
    readonly order?: number;
    readonly note?: number;
  };
  /** Days a lifted or replaced order stays listed as lifted. Default 7. */
  readonly liftedVisibleDays?: number;
  /**
   * Most entries held at once, so one run that goes wrong can't fill the volume (a probe wrote 5,000 loops in a
   * second). Defaults: open loops 200, active orders 50, live notes 100. A write past a cap is refused.
   */
  readonly limits?: { readonly loops?: number; readonly orders?: number; readonly notes?: number };
  /** Events kept per entry: its first, and its latest up to this many in all. Default 50. */
  readonly eventsPerEntry?: number;
}

// What a wake needs of the opening turn's auth to send as it, and nothing else: no email or names at rest.
const KEPT_ATTRIBUTES = ["user_id", "team_id", "channel_id", "thread_ts"] as const;

/** The opening turn's auth as a loop keeps it: the fields delivery needs, without personal details. */
export function deliveryPrincipal(auth: SessionAuthContext): SessionAuthContext {
  const attributes: Record<string, string | readonly string[]> = {};
  for (const key of KEPT_ATTRIBUTES) {
    const value = auth.attributes?.[key];
    if (value !== undefined) attributes[key] = value;
  }
  return {
    principalId: auth.principalId,
    principalType: auth.principalType,
    authenticator: auth.authenticator,
    ...(auth.issuer !== undefined ? { issuer: auth.issuer } : {}),
    attributes,
  };
}

/** The store's file inside its directory. */
export const workingStorePath = (dir: string): string => join(dir, "working.sqlite");

const DAY = 24 * 60 * 60_000;

// ----- the follow-ups grammar, absorbed from the baseline's follow-ups store so the baseline can retire its own -----

const RELATIVE = /^in (\d{1,4}) (minute|hour|day)s?$/i;
const UNIT_MS = { minute: 60_000, hour: 60 * 60_000, day: DAY } as const;
const isoWithOffset = z.iso.datetime({ offset: true });

/** When `when` falls, in epoch ms, or why it can't be scheduled. */
export function parseWhen(when: string, now: number): { at: number } | { refused: string } {
  const relative = RELATIVE.exec(when);
  if (relative !== null) {
    const amount = Number(relative[1]);
    if (amount === 0) return { refused: "that's now; a revisit is for later" };
    const unit = (relative[2] as string).toLowerCase() as keyof typeof UNIT_MS;
    return { at: now + amount * UNIT_MS[unit] };
  }
  if (!isoWithOffset.safeParse(when).success)
    return {
      refused: `"${when}" isn't a time I can read: give an ISO 8601 time with its offset, such as 2026-11-02T16:00:00Z or 2026-11-02T09:00:00-07:00, or "in N minutes", "in N hours" or "in N days"`,
    };
  const at = Date.parse(when);
  if (at <= now) return { refused: `${when} has already passed` };
  return { at };
}

/**
 * The event key `on` names, or why it isn't one. `events` is every key the host can fire (its wake engine calls
 * `eventOccurred` with them); matching ignores case.
 */
export function parseOn(
  on: string,
  events: readonly string[],
): { event: string } | { refused: string } {
  if (events.length === 0)
    return { refused: "there are no events to wait on here; give a time with `when` instead" };
  const event = events.find((e) => e.toLowerCase() === on.trim().toLowerCase());
  if (event === undefined)
    return {
      refused: `"${on}" isn't an event a loop can wait on; the ones there are: ${events.join(", ")}`,
    };
  return { event };
}

/** An order's subject as it's matched and stored: trimmed, lowercased, inner whitespace collapsed. */
export const normalSubject = (subject: string): string =>
  subject.trim().replace(/\s+/g, " ").toLowerCase();

// ----- schema -----

// Additive only: each step runs once, in order, so a store written by an earlier version opens in a later one.
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE loops (
    id TEXT PRIMARY KEY,
    conversation_key TEXT NOT NULL,
    address TEXT NOT NULL,
    principal TEXT,
    what TEXT NOT NULL,
    waiting_on TEXT NOT NULL,
    next TEXT NOT NULL,
    links TEXT NOT NULL,
    signature TEXT,
    due_at INTEGER,
    on_event TEXT,
    wake TEXT CHECK (wake IN ('pending', 'undeliverable')),
    wake_set_at INTEGER,
    lease_until INTEGER,
    lease_token TEXT,
    fired_by TEXT,
    followup_note TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'delivering', 'done', 'dropped')),
    why TEXT,
    review_by INTEGER NOT NULL,
    origin TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    followup_id TEXT UNIQUE
  );
  CREATE INDEX loops_due ON loops (status, due_at);
  CREATE INDEX loops_conversation ON loops (conversation_key, status);
  CREATE TABLE orders (
    id TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    rule TEXT NOT NULL,
    link TEXT NOT NULL,
    until INTEGER,
    status TEXT NOT NULL CHECK (status IN ('active', 'lifted', 'replaced')),
    why TEXT,
    review_by INTEGER NOT NULL,
    origin TEXT NOT NULL,
    ended_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX orders_one_active ON orders (subject) WHERE status = 'active';
  CREATE TABLE notes (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    origin TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_kind TEXT NOT NULL,
    entry_id TEXT NOT NULL,
    change TEXT NOT NULL,
    before TEXT,
    after TEXT,
    origin TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX events_entry ON events (entry_id, seq);
  `,
];
/** The schema version this package writes. */
export const SCHEMA_VERSION = MIGRATIONS.length;

type Table = "loops" | "orders" | "notes";
const TABLE_KIND = { loops: "loop", orders: "order", notes: "note" } as const;
const KIND_TABLE = { loop: "loops", order: "orders", note: "notes" } as const;

/** What the wake engine's own changes are attributed to. */
const WAKE_ORIGIN: Origin = { principalId: null, kind: "scheduled", sessionId: null };
const EVENT_ORIGIN: Origin = { principalId: null, kind: "webhook", sessionId: null };

let orderChanges = 0;
/** Order changes this process has logged: an operator's order lifted or replaced from another origin kind. */
export const orderChangeCount = (): number => orderChanges;

const newId = (prefix: string) => `${prefix}${randomBytes(4).toString("hex")}`;
const iso = (ms: number) => new Date(ms).toISOString();

/** How a loop's wake begins, which the host's instructions can name. */
export const LOOP_WAKE_OPENING = "A loop you opened is due";

const OPENED: Record<OriginKind, string> = {
  operator: "in the operator's own conversation",
  colleague: "at a colleague's request",
  scheduled: "by a scheduled run",
  webhook: "by a webhook turn",
  delegated: "by a delegated task",
  other: "in a conversation with someone other than the operator",
};
// Model-written text goes into the wake on one line, so it can't pose as a recall block or a new instruction.
const flat = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * The wake's text, which the host posts as written: it names the loop and who opened it, and stands alone after a
 * restart. Every loop's wake, imported or not, is built here.
 */
export function followupNoteOf(loop: {
  id: string;
  what: string;
  next: string;
  links: readonly string[];
  createdAt: number;
  origin: Pick<Origin, "kind">;
}): string {
  const links = loop.links.length > 0 ? `\nLinks: ${loop.links.map(flat).join(" ")}` : "";
  return `${LOOP_WAKE_OPENING} (${loop.id}, opened ${iso(loop.createdAt).slice(0, 16)}Z ${OPENED[loop.origin.kind]}): ${flat(loop.what)}\nNext: ${flat(loop.next)}${links}\nWhen it's done, close loop ${loop.id}; to come back to it again, update its revisit.`;
}

/**
 * The agent's working state, in one SQLite file. Every write is one IMMEDIATE transaction holding the entry and its
 * event together; a claim is one `UPDATE … RETURNING`, so two overlapping ticks can't both claim a loop.
 */
export class WorkingStore {
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  readonly #days: { loop: number; order: number; note: number };
  readonly #liftedMs: number;
  readonly #limits: { loops: number; orders: number; notes: number };
  readonly #eventsPerEntry: number;

  constructor(path: string, options: WorkingStoreOptions = {}) {
    // Only the agent's own user reads its working state: the directory it makes is 0700 and the file 0600.
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#now = options.now ?? Date.now;
    this.#days = {
      loop: options.reviewAfterDays?.loop ?? 7,
      order: options.reviewAfterDays?.order ?? 14,
      note: options.reviewAfterDays?.note ?? 7,
    };
    this.#liftedMs = (options.liftedVisibleDays ?? 7) * DAY;
    this.#limits = {
      loops: options.limits?.loops ?? 200,
      orders: options.limits?.orders ?? 50,
      notes: options.limits?.notes ?? 100,
    };
    this.#eventsPerEntry = Math.max(2, options.eventsPerEntry ?? 50);
    const db = new DatabaseSync(path);
    this.#db = db;
    try {
      if (path !== ":memory:") chmodSync(path, 0o600);
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("PRAGMA journal_mode = WAL");
      this.#migrate();
    } catch (error) {
      db.close();
      throw error;
    }
  }

  #migrate(): void {
    this.#tx(() => {
      const { user_version: version } = this.#db.prepare("PRAGMA user_version").get() as {
        user_version: number;
      };
      for (let v = Number(version); v < MIGRATIONS.length; v++)
        this.#db.exec(MIGRATIONS[v] as string);
      if (Number(version) < MIGRATIONS.length)
        this.#db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
    });
  }

  /** Closes the database. */
  close(): void {
    this.#db.close();
  }

  #tx<T>(fn: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.#db.exec("COMMIT");
      return out;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #row(table: Table, id: string): Row | undefined {
    return this.#db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Row | undefined;
  }

  // Writes a whole row, new or replacing, and its event. Every change but a claim or an event's wake goes through
  // here, so no change lands without its history.
  #put(table: Table, before: Row | null, after: Row, change: string, origin: Origin): void {
    const cols = Object.keys(after);
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
      )
      .run(...cols.map((c) => after[c] ?? null));
    this.#event(table, String(after.id), change, before, after, origin);
  }

  #event(
    table: Table,
    id: string,
    change: string,
    before: Row | null,
    after: Row | null,
    origin: Origin,
  ): void {
    this.#db
      .prepare(
        "INSERT INTO events (entry_kind, entry_id, change, before, after, origin, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        TABLE_KIND[table],
        id,
        change,
        before && JSON.stringify(withoutPrincipal(before)),
        after && JSON.stringify(withoutPrincipal(after)),
        JSON.stringify(origin),
        this.#now(),
      );
    // Bounded history: an entry keeps its first event (how it began) and its latest ones.
    this.#db
      .prepare(
        `DELETE FROM events WHERE entry_id = ?
           AND seq != (SELECT min(seq) FROM events WHERE entry_id = ?)
           AND seq NOT IN (SELECT seq FROM events WHERE entry_id = ? ORDER BY seq DESC LIMIT ?)`,
      )
      .run(id, id, id, this.#eventsPerEntry - 1);
  }

  #count(sql: string, ...params: number[]): number {
    return Number((this.#db.prepare(sql).get(...params) as { n: number }).n);
  }

  // A delivering loop whose lease ran out has no live claimant: it counts as open again.
  #held(row: Row, now: number): boolean {
    return row.status === "delivering" && Number(row.lease_until ?? 0) > now;
  }

  #wake(revisit: Revisit | undefined | null, deliverable: boolean, now: number): Row {
    if (!revisit || (revisit.dueAt === undefined && revisit.onEvent === undefined))
      return { due_at: null, on_event: null, wake: null, wake_set_at: null };
    return {
      due_at: revisit.dueAt ?? null,
      on_event: revisit.onEvent ?? null,
      wake: deliverable ? "pending" : "undeliverable",
      wake_set_at: now,
      fired_by: null,
    };
  }

  /** Opens a loop in its conversation and answers it. */
  open(input: OpenInput, origin: Origin): Result<{ loop: Loop }> {
    const now = this.#now();
    const open = this.#count(
      "SELECT count(*) AS n FROM loops WHERE status IN ('open', 'delivering')",
    );
    if (open >= this.#limits.loops)
      return {
        ok: false,
        reason: `There are already ${open} open loops, the most this agent keeps. Close the ones that are resolved or no longer worth doing (close), then open this one.`,
      };
    const id = newId("L");
    const links = [...(input.links ?? [])];
    const row: Row = {
      id,
      conversation_key: addressKey(input.address),
      address: JSON.stringify(input.address),
      principal: input.principal ? JSON.stringify(deliveryPrincipal(input.principal)) : null,
      what: input.what,
      waiting_on: input.waitingOn,
      next: input.next,
      links: JSON.stringify(links),
      signature: input.signature ?? null,
      fired_by: null,
      ...this.#wake(input.revisit, input.deliverable !== false, now),
      lease_until: null,
      lease_token: null,
      followup_note: followupNoteOf({
        id,
        what: input.what,
        next: input.next,
        links,
        createdAt: now,
        origin,
      }),
      status: "open",
      why: null,
      review_by: input.reviewBy ?? now + this.#days.loop * DAY,
      origin: JSON.stringify(origin),
      created_at: now,
      updated_at: now,
      followup_id: null,
    };
    this.#tx(() => this.#put("loops", null, row, "opened", origin));
    return { ok: true, loop: toLoop(row) };
  }

  /** Changes an open loop's next action, whose move it is, its links, its wake or its review date. */
  update(id: string, input: UpdateInput, origin: Origin): Result<{ loop: Loop }> {
    return this.#tx(() => {
      const now = this.#now();
      const before = this.#row("loops", id);
      if (!before) return unknownLoop(id);
      if (before.status === "done" || before.status === "dropped")
        return {
          ok: false,
          reason: `Loop ${id} is already ${before.status}; open a new loop if there's more to do.`,
        };
      if (this.#held(before, now)) return delivering(id);
      const next = input.next ?? String(before.next);
      const links = input.links ? [...input.links] : (JSON.parse(String(before.links)) as string[]);
      const after: Row = {
        ...before,
        status: "open",
        lease_until: null,
        lease_token: null,
        waiting_on: input.waitingOn ?? before.waiting_on,
        next,
        links: JSON.stringify(links),
        ...(input.revisit !== undefined
          ? this.#wake(input.revisit, input.deliverable !== false, now)
          : {}),
        review_by: input.reviewBy ?? before.review_by,
        followup_note: followupNoteOf({
          id,
          what: String(before.what),
          next,
          links,
          createdAt: Number(before.created_at),
          origin: JSON.parse(String(before.origin)) as Origin,
        }),
        updated_at: now,
      };
      this.#put("loops", before, after, "updated", origin);
      return { ok: true, loop: toLoop(after) };
    });
  }

  /** Closes a loop as done or dropped, with why; any pending wake goes with it. */
  closeLoop(
    id: string,
    outcome: "done" | "dropped",
    why: string,
    origin: Origin,
  ): Result<{ loop: Loop }> {
    return this.#tx(() => {
      const now = this.#now();
      const before = this.#row("loops", id);
      if (!before) return unknownLoop(id);
      if (before.status === "done" || before.status === "dropped") {
        const closing = this.history(id)
          .filter((e) => e.change === "closed")
          .at(-1);
        const when = closing ? ` on ${iso(closing.at)}` : "";
        return {
          ok: false,
          reason: `Loop ${id} was already closed as ${before.status}${when}${before.why ? `: ${before.why}` : ""}. Nothing changed.`,
        };
      }
      if (this.#held(before, now)) return delivering(id);
      const after: Row = {
        ...before,
        status: outcome,
        why,
        ...this.#wake(null, true, now),
        lease_until: null,
        lease_token: null,
        updated_at: now,
      };
      this.#put("loops", before, after, "closed", origin);
      return { ok: true, loop: toLoop(after) };
    });
  }

  /** Sets the order on a subject. An active order on the same subject is replaced, and kept in history. */
  setOrder(
    input: { subject: string; rule: string; link: string; until?: number },
    origin: Origin,
  ): Result<{ order: Order; replaced: Order | null }> {
    return this.#tx(() => {
      const now = this.#now();
      const id = newId("O");
      const subject = normalSubject(input.subject);
      const current = this.#activeOrder(subject);
      const active = this.#count("SELECT count(*) AS n FROM orders WHERE status = 'active'");
      if (!current && active >= this.#limits.orders)
        return {
          ok: false,
          reason: `There are already ${active} active orders, the most this agent keeps. Lift the ones no longer in force (lift), then set this one.`,
        };
      let replaced: Row | null = null;
      if (current) {
        replaced = {
          ...current,
          status: "replaced",
          why: `replaced by ${id}`,
          ended_by: JSON.stringify(origin),
          updated_at: now,
        };
        this.#put("orders", current, replaced, "replaced", origin);
        this.#detectOrderChange(current, origin);
      }
      const row: Row = {
        id,
        subject,
        rule: input.rule,
        link: input.link,
        until: input.until ?? null,
        status: "active",
        why: null,
        review_by: now + this.#days.order * DAY,
        origin: JSON.stringify(origin),
        ended_by: null,
        created_at: now,
        updated_at: now,
      };
      this.#put("orders", null, row, "set", origin);
      return { ok: true, order: toOrder(row), replaced: replaced && toOrder(replaced) };
    });
  }

  /** Lifts the active order on a subject, with why. */
  liftOrder(subject: string, why: string, origin: Origin): Result<{ order: Order }> {
    return this.#tx(() => {
      const current = this.#activeOrder(normalSubject(subject));
      if (!current)
        return {
          ok: false,
          reason: `There's no active order on "${subject}". List orders to see the subjects that have one.`,
        };
      const after: Row = {
        ...current,
        status: "lifted",
        why,
        ended_by: JSON.stringify(origin),
        updated_at: this.#now(),
      };
      this.#put("orders", current, after, "lifted", origin);
      this.#detectOrderChange(current, origin);
      return { ok: true, order: toOrder(after) };
    });
  }

  #activeOrder(subject: string): Row | undefined {
    return this.#db
      .prepare("SELECT * FROM orders WHERE subject = ? AND status = 'active'")
      .get(normalSubject(subject)) as Row | undefined;
  }

  // Detection, not a gate: the counterpart of the graph's owner-overwrite line. An order lifted or replaced by anyone
  // other than whoever set it (another principal, or another kind of turn) is logged with both origins and a running
  // count, so an operator's hold lifted from a colleague's thread can be found.
  #detectOrderChange(order: Row, origin: Origin): void {
    const set = JSON.parse(String(order.origin)) as Origin;
    if (set.kind === origin.kind && set.principalId === origin.principalId) return;
    orderChanges++;
    const who = (o: Origin) => `${o.kind}${o.principalId ? `(${o.principalId})` : ""}`;
    console.warn(
      `[working] order-change subject=${JSON.stringify(order.subject)} set_by=${who(set)} by=${who(origin)} count=${orderChanges}`,
    );
  }

  /** Adds a note, which expires on its own. */
  addNote(input: { text: string; expiresAt?: number }, origin: Origin): Result<{ note: Note }> {
    const now = this.#now();
    const live = this.#count("SELECT count(*) AS n FROM notes WHERE expires_at > ?", now);
    if (live >= this.#limits.notes)
      return {
        ok: false,
        reason: `There are already ${live} live notes, the most this agent keeps. Let older ones expire, or keep this as a loop instead.`,
      };
    const row: Row = {
      id: newId("N"),
      text: input.text,
      expires_at: input.expiresAt ?? now + this.#days.note * DAY,
      origin: JSON.stringify(origin),
      created_at: now,
      updated_at: now,
    };
    this.#tx(() => this.#put("notes", null, row, "added", origin));
    return { ok: true, note: toNote(row, now) };
  }

  /** Entries for one view, newest first, each kind capped at `limit` with its total. */
  list(filter: ListFilter): Listing {
    const now = this.#now();
    const limit = Math.min(Math.max(1, filter.limit ?? 50), 200);
    const key = filter.conversationKey ?? null;
    type Where = readonly [string, readonly (string | number)[]] | null;
    const OPEN = "status IN ('open', 'delivering')";
    const loopWhere: Partial<Record<ListView, Where>> = {
      here: key === null ? null : [`${OPEN} AND conversation_key = ?`, [key]],
      elsewhere: key === null ? [OPEN, []] : [`${OPEN} AND conversation_key != ?`, [key]],
      stale: [`${OPEN} AND review_by <= ?`, [now]],
      all: [OPEN, []],
    };
    const orderWhere: Partial<Record<ListView, Where>> = {
      orders: ["status = 'active'", []],
      stale: ["status = 'active' AND (review_by <= ? OR until <= ?)", [now, now]],
      lifted: ["status != 'active' AND updated_at > ?", [now - this.#liftedMs]],
      all: ["status = 'active'", []],
    };
    const noteWhere: Partial<Record<ListView, Where>> = {
      notes: ["expires_at > ?", [now]],
      all: ["expires_at > ?", [now]],
    };
    const select = (table: Table, where: Where | undefined) => {
      if (!where) return { rows: [] as Row[], total: 0 };
      const [clause, params] = where;
      const { n } = this.#db
        .prepare(`SELECT count(*) AS n FROM ${table} WHERE ${clause}`)
        .get(...params) as { n: number };
      const rows = this.#db
        .prepare(`SELECT * FROM ${table} WHERE ${clause} ORDER BY updated_at DESC, id LIMIT ?`)
        .all(...params, limit) as Row[];
      return { rows, total: Number(n) };
    };
    const loops = select("loops", loopWhere[filter.view]);
    const orders = select("orders", orderWhere[filter.view]);
    const notes = select("notes", noteWhere[filter.view]);
    return {
      loops: loops.rows.map(toLoop),
      orders: orders.rows.map(toOrder),
      notes: notes.rows.map((r) => toNote(r, now)),
      totals: { loops: loops.total, orders: orders.total, notes: notes.total },
    };
  }

  /**
   * Leases every loop whose wake is due, however late, and isn't held by a live lease. A claimant that dies before
   * settling leaves its lease to expire, and the loop is claimed again: delivery is at least once.
   */
  claimDue(now: number, leaseMs: number): ClaimedLoop[] {
    const token = randomBytes(8).toString("hex");
    return this.#tx(() => {
      const rows = this.#db
        .prepare(
          `UPDATE loops SET status = 'delivering', lease_until = ?, lease_token = ?
           WHERE wake = 'pending' AND due_at IS NOT NULL AND due_at <= ?
             AND (status = 'open' OR (status = 'delivering' AND lease_until <= ?))
           RETURNING *`,
        )
        .all(now + leaseMs, token, now, now) as Row[];
      for (const row of rows)
        this.#event("loops", String(row.id), "wake-claimed", null, row, WAKE_ORIGIN);
      return rows.map((row) => ({
        id: String(row.id),
        address: JSON.parse(String(row.address)) as Address,
        conversationKey: String(row.conversation_key),
        principal:
          row.principal === null ? null : (JSON.parse(String(row.principal)) as SessionAuthContext),
        followupNote: String(row.followup_note),
        dueAt: num(row.due_at),
        onEvent: str(row.on_event),
        firedBy: str(row.fired_by),
        leaseToken: token,
        createdAt: Number(row.created_at),
      }));
    });
  }

  /**
   * The wake was delivered: the loop is open again with its wake spent. A wake isn't a resolution; the woken turn
   * closes the loop or sets a new revisit. False when this claimant no longer holds it.
   */
  settleWake(id: string, leaseToken: string, firedBy: string): boolean {
    return this.#tx(() => {
      const now = this.#now();
      const before = this.#row("loops", id);
      if (before?.status !== "delivering" || before.lease_token !== leaseToken) return false;
      const after: Row = {
        ...before,
        status: "open",
        lease_until: null,
        lease_token: null,
        ...this.#wake(null, true, now),
        fired_by: firedBy,
        updated_at: now,
      };
      this.#put("loops", before, after, "wake-delivered", WAKE_ORIGIN);
      return true;
    });
  }

  /**
   * An event happened at `occurredAt`: every open loop waiting on it, whose wake was set by then, becomes due `now`.
   * One set after it waits for the next, so a redelivered old event wakes nothing new. The wake's set time decides,
   * not the loop's creation, since `update` can add a revisit to an old loop. Answers how many became due.
   */
  eventOccurred(event: string, occurredAt: number, firedBy: string, now: number): number {
    return this.#tx(() => {
      const rows = this.#db
        .prepare(
          `UPDATE loops SET due_at = ?, fired_by = ?, updated_at = ?
           WHERE status = 'open' AND wake IS NOT NULL AND on_event = ? AND due_at IS NULL
             AND wake_set_at <= ?
           RETURNING *`,
        )
        .all(now, firedBy, now, event, occurredAt) as Row[];
      for (const row of rows)
        this.#event("loops", String(row.id), "event-occurred", null, row, EVENT_ORIGIN);
      return rows.length;
    });
  }

  /** One loop by id, whatever its status. */
  loop(id: string): Loop | undefined {
    const row = this.#row("loops", id);
    return row && toLoop(row);
  }

  /** Every recorded change to an entry, oldest first. */
  history(id: string): EntryEvent[] {
    return (
      this.#db.prepare("SELECT * FROM events WHERE entry_id = ? ORDER BY seq").all(id) as Row[]
    ).map(toEvent);
  }

  /**
   * Undoes every change a session, turn, tool call or principal made: each entry it touched goes back to how it was
   * before its first such change, and one it created is closed (a loop dropped, an order lifted, a note expired).
   * Nothing is deleted; the revert is itself an event. An empty filter reverts nothing. Answers how many entries.
   */
  revertBatch(filter: RevertFilter, origin: Origin): number {
    const fields = (["sessionId", "turnId", "callId", "principalId"] as const).filter(
      (f) => filter[f] !== undefined,
    );
    if (fields.length === 0) return 0;
    return this.#tx(() => {
      const now = this.#now();
      const matched = this.#db
        .prepare(
          `SELECT * FROM events WHERE ${fields.map((f) => `json_extract(origin, '$.${f}') = ?`).join(" AND ")} ORDER BY seq`,
        )
        .all(...fields.map((f) => filter[f] as string)) as Row[];
      const first = new Map<string, Row>();
      for (const e of matched) {
        const key = `${e.entry_kind}\u0000${e.entry_id}`;
        if (!first.has(key)) first.set(key, e);
      }
      for (const e of first.values()) {
        const table: Table = KIND_TABLE[e.entry_kind as Entry["kind"]];
        const current = this.#row(table, String(e.entry_id));
        if (!current) continue;
        const before = e.before === null ? null : (JSON.parse(String(e.before)) as Row);
        const after: Row = before
          ? {
              ...before,
              ...(table === "loops" ? { principal: current.principal } : {}),
              updated_at: now,
            }
          : table === "loops"
            ? {
                ...current,
                status: "dropped",
                why: "reverted",
                ...this.#wake(null, true, now),
                lease_until: null,
                lease_token: null,
                updated_at: now,
              }
            : table === "orders"
              ? {
                  ...current,
                  status: "lifted",
                  why: "reverted",
                  ended_by: JSON.stringify(origin),
                  updated_at: now,
                }
              : { ...current, expires_at: now, updated_at: now };
        // Restoring an order to active over a subject that has another active one would break one-per-subject.
        if (table === "orders" && after.status === "active") {
          const other = this.#activeOrder(String(after.subject));
          if (other && other.id !== after.id)
            this.#put(
              "orders",
              other,
              {
                ...other,
                status: "replaced",
                why: `reverted to ${after.id}`,
                ended_by: JSON.stringify(origin),
                updated_at: now,
              },
              "replaced",
              origin,
            );
        }
        this.#put(table, current, after, "reverted", origin);
      }
      return first.size;
    });
  }

  /**
   * Imports the baseline's follow-ups file as loops, once: a pending follow-up becomes an open loop with its wake, a
   * done one a done loop, a cancelled one a dropped loop. The note's first line is the loop's `what`, the rest its
   * `next` (each capped as the tools cap them), and the wake text is built as any loop's. A row whose principal
   * doesn't parse is skipped and counted in `skipped`. `resolve` is the host's address resolver, given the follow-up's
   * principal; a row it can't place is left out and counted. Re-running imports nothing twice.
   */
  migrateFollowups(
    path: string,
    resolve: (principal: SessionAuthContext) => Address | null,
  ): MigrationReport {
    if (!existsSync(path)) return { imported: 0, skipped: 0, unresolved: 0 };
    const source = new DatabaseSync(path, { readOnly: true });
    let rows: Row[];
    try {
      rows = source.prepare("SELECT * FROM followups ORDER BY created_at, id").all() as Row[];
    } finally {
      source.close();
    }
    const STATUS: Record<string, LoopStatus> = {
      pending: "open",
      done: "done",
      cancelled: "dropped",
    };
    const report = { imported: 0, skipped: 0, unresolved: 0 };
    this.#tx(() => {
      const now = this.#now();
      for (const f of rows) {
        const followupId = String(f.id);
        if (this.#db.prepare("SELECT 1 FROM loops WHERE followup_id = ?").get(followupId)) {
          report.skipped++;
          continue;
        }
        let principal: SessionAuthContext;
        try {
          principal = deliveryPrincipal(JSON.parse(String(f.principal)) as SessionAuthContext);
        } catch {
          report.skipped++;
          continue;
        }
        const address = resolve(principal);
        const status = STATUS[String(f.status)];
        if (address === null || status === undefined) {
          report.unresolved++;
          continue;
        }
        const note = String(f.note);
        const [head = "", ...rest] = note.split("\n");
        const origin: Origin = {
          principalId: principal.principalId ?? null,
          kind: "other",
          sessionId: null,
        };
        const pending = status === "open";
        const row: Row = {
          id: newId("L"),
          conversation_key: addressKey(address),
          address: JSON.stringify(address),
          principal: JSON.stringify(principal),
          what: clip(head.trim() || "follow-up", 200),
          waiting_on: "me",
          next: clip(rest.join("\n").trim() || head.trim(), 500),
          links: "[]",
          signature: null,
          due_at: f.due_at,
          on_event: f.on_event,
          wake: pending ? "pending" : null,
          wake_set_at: pending ? Number(f.created_at) : null,
          lease_until: null,
          lease_token: null,
          fired_by: f.fired_by,
          followup_note: "",
          status,
          why: pending ? null : `migrated from a ${String(f.status)} follow-up`,
          review_by: now + this.#days.loop * DAY,
          origin: JSON.stringify(origin),
          created_at: Number(f.created_at),
          updated_at: now,
          followup_id: followupId,
        };
        row.followup_note = followupNoteOf({
          id: String(row.id),
          what: String(row.what),
          next: String(row.next),
          links: [],
          createdAt: Number(row.created_at),
          origin,
        });
        this.#put("loops", null, row, "migrated", origin);
        report.imported++;
      }
    });
    return report;
  }
}

// Event rows keep attribution (the origin) but not the sender auth, which only the live loop needs for its wake.
const withoutPrincipal = (row: Row): Row => {
  const { principal: _, ...rest } = row;
  return rest;
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const unknownLoop = (id: string): Refusal => ({
  ok: false,
  reason: `There's no loop ${id}. List loops to see their ids.`,
});
const delivering = (id: string): Refusal => ({
  ok: false,
  reason: `Loop ${id}'s wake is being delivered right now. Try again after it arrives.`,
});

const str = (v: Row[string] | undefined) => (v === null || v === undefined ? null : String(v));
const num = (v: Row[string] | undefined) => (v === null || v === undefined ? null : Number(v));

function toLoop(row: Row): Loop {
  return {
    id: String(row.id),
    kind: "loop",
    status: row.status as LoopStatus,
    conversationKey: String(row.conversation_key),
    address: JSON.parse(String(row.address)) as Address,
    what: String(row.what),
    waitingOn: String(row.waiting_on),
    next: String(row.next),
    links: JSON.parse(String(row.links)) as string[],
    signature: str(row.signature),
    dueAt: num(row.due_at),
    onEvent: str(row.on_event),
    wake: str(row.wake) as WakeState | null,
    firedBy: str(row.fired_by),
    why: str(row.why),
    followupNote: String(row.followup_note),
    reviewBy: Number(row.review_by),
    origin: JSON.parse(String(row.origin)) as Origin,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toOrder(row: Row): Order {
  return {
    id: String(row.id),
    kind: "order",
    status: row.status as OrderStatus,
    subject: String(row.subject),
    rule: String(row.rule),
    link: String(row.link),
    until: num(row.until),
    why: str(row.why),
    reviewBy: Number(row.review_by),
    origin: JSON.parse(String(row.origin)) as Origin,
    endedBy: row.ended_by ? (JSON.parse(String(row.ended_by)) as Origin) : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toNote(row: Row, now: number): Note {
  return {
    id: String(row.id),
    kind: "note",
    status: Number(row.expires_at) > now ? "active" : "expired",
    text: String(row.text),
    expiresAt: Number(row.expires_at),
    origin: JSON.parse(String(row.origin)) as Origin,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toEvent(row: Row): EntryEvent {
  return {
    seq: Number(row.seq),
    entryKind: row.entry_kind as Entry["kind"],
    entryId: String(row.entry_id),
    change: String(row.change),
    before: row.before === null ? null : (JSON.parse(String(row.before)) as Row),
    after: row.after === null ? null : (JSON.parse(String(row.after)) as Row),
    origin: JSON.parse(String(row.origin)) as Origin,
    at: Number(row.at),
  };
}

export interface OpenWorkingStoreOptions extends WorkingStoreOptions {
  /** The store's directory; the file is `<dir>/working.sqlite`. */
  readonly dir: string;
  /** A follow-ups file to import, once, as the store opens; `resolve` places its rows. */
  readonly followups?: string;
  readonly resolve?: (principal: SessionAuthContext) => Address | null;
}

/**
 * Opens the agent's store, importing a follow-ups file first when given one. The provider and the host's wake engine
 * both open through here, so whichever runs first after a start migrates, and neither reads before the import. The
 * import is one IMMEDIATE transaction and skips rows already imported, so running it from both is harmless.
 */
export function openWorkingStore(options: OpenWorkingStoreOptions): WorkingStore {
  const store = new WorkingStore(workingStorePath(options.dir), options);
  try {
    if (options.followups !== undefined) {
      if (options.resolve === undefined)
        throw new Error("openWorkingStore: followups needs resolve");
      const r = store.migrateFollowups(options.followups, options.resolve);
      // The import's only other trace is the stats' open count; a row with no address would vanish unremarked.
      if (r.imported + r.unresolved > 0)
        console.log(
          `[working] imported follow-ups imported=${r.imported} skipped=${r.skipped} unresolved=${r.unresolved}`,
        );
    }
  } catch (error) {
    store.close();
    throw error;
  }
  return store;
}
