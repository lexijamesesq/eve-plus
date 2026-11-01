// The working store: loops, orders and notes in one SQLite file per agent, with every change kept as an attributed
// event. Closing a loop or lifting an order is an event, never a deletion; closed entries are pruned after a retention
// window. The host's wake engine drives loops' wakes through claimDue / settleWake / failWake / eventOccurred; delivery
// stays with the host, which knows its channels.

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SessionAuthContext } from "eve/context";
import { z } from "zod";

import { type Address, addressKey, addressSchema } from "./addresses.js";
import { clip, flat, KIND } from "./render.js";

export { type Address, addressKey } from "./addresses.js";

/** Who a write came from, by the kind of turn that made it. The host classifies; the package never asks the model. */
export type OriginKind = "operator" | "colleague" | "scheduled" | "webhook" | "delegated" | "other";

/** The attribution every write records, from eve's session and tool context. */
export interface Origin {
  readonly principalId: string | null;
  readonly kind: OriginKind;
  readonly sessionId: string | null;
  readonly turnId?: string;
  readonly turnSequence?: number;
  readonly callId?: string;
}

export type LoopStatus = "open" | "delivering" | "done" | "dropped";
export type OrderStatus = "active" | "lifted" | "replaced";
/** A loop's wake: due on its time or event, or recorded where the host can't hand off and shown as due instead. */
export type WakeState = "pending" | "undeliverable";

export interface Loop {
  readonly id: string;
  readonly status: LoopStatus;
  readonly conversationKey: string;
  readonly address: Address;
  readonly what: string;
  readonly waitingOn: string;
  readonly next: string;
  readonly links: readonly string[];
  readonly dueAt: number | null;
  readonly onEvent: string | null;
  readonly wake: WakeState | null;
  readonly firedBy: string | null;
  /** Claims of the current wake that weren't settled, and the last failure's reason. */
  readonly wakeAttempts: number;
  readonly wakeError: string | null;
  readonly why: string | null;
  readonly reviewBy: number;
  readonly origin: Origin;
  /** Who last changed it after it was opened, if anyone did. */
  readonly lastEditedBy: Origin | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface Order {
  readonly id: string;
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
  readonly text: string;
  readonly expiresAt: number;
  readonly origin: Origin;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type Row = Record<string, string | number | null>;

/** One recorded change to an entry. `before` and `after` are its stored row, without the sender auth. */
export interface EntryEvent {
  readonly seq: number;
  readonly entryKind: "loop" | "order" | "note";
  readonly entryId: string;
  readonly change: string;
  readonly before: Row | null;
  readonly after: Row | null;
  readonly origin: Origin;
  readonly at: number;
}

/** A loop leased for delivery. Only the holder of `leaseToken` can settle or fail it. */
export interface ClaimedLoop {
  readonly id: string;
  readonly address: Address;
  readonly conversationKey: string;
  /** The opening turn's session auth, for the host to send the wake as. Attribution is `Loop.origin`'s. */
  readonly principal: SessionAuthContext | null;
  /** The wake's text, to send as written. */
  readonly followupNote: string;
  readonly dueAt: number | null;
  readonly onEvent: string | null;
  readonly firedBy: string | null;
  /** Which arming of the loop's wake this is: new each time a revisit is set, so `loop:<id>:<wakeSeq>` keys one send. */
  readonly wakeSeq: number;
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

/** A loop brought in from another store by the host, once: `externalId` is its id there. */
export interface ImportedLoop {
  readonly externalId: string;
  readonly address: Address;
  readonly principal: SessionAuthContext | null;
  readonly what: string;
  readonly next: string;
  readonly waitingOn?: string;
  readonly links?: readonly string[];
  readonly status: "open" | "done" | "dropped";
  /** Its wake, kept only while it's open. */
  readonly wake?: {
    readonly dueAt?: number | null;
    readonly onEvent?: string | null;
    readonly firedBy?: string | null;
  };
  readonly createdAt: number;
  readonly why?: string;
  readonly origin: Origin;
}

export interface WorkingStoreOptions {
  readonly now?: () => number;
  /** Days before an entry is marked stale. Defaults: loop 7, order 14, note 7 (a note expires then). */
  readonly reviewAfterDays?: {
    readonly loop?: number;
    readonly order?: number;
    readonly note?: number;
  };
  /**
   * Most entries held at once, so one run that goes wrong can't fill the volume (a probe wrote 5,000 loops in a
   * second). Defaults: open loops 200, active orders 50, live notes 100. A write past a cap is refused.
   */
  readonly limits?: { readonly loops?: number; readonly orders?: number; readonly notes?: number };
  /** Events kept per entry: its first, and its latest up to this many in all. Default 50. */
  readonly eventsPerEntry?: number;
  /**
   * Days a closed loop, an ended order or an expired note is kept, with its history, before it's pruned (20,000
   * open-close cycles grew a store to 248 MB without it). Default 30.
   */
  readonly retentionDays?: number;
  /** Unsettled claims before a wake is given up as undeliverable. Default 5. */
  readonly maxWakeAttempts?: number;
  /** Most loops one `claimDue` claims, oldest due first, so a backlog drains over several ticks. Default 20. */
  readonly claimLimit?: number;
  /**
   * The auth attributes a loop keeps of the turn that opened it, for the host to send its wake as; every other
   * attribute (email, names) is dropped before storage. Default: user_id, team_id, channel_id, thread_ts.
   */
  readonly principalAttributes?: readonly string[];
  /** The `<scheme>:` references a link may be, beside http(s) URLs; empty means URLs only. Default: the six below. */
  readonly linkSchemes?: readonly string[];
}

/** The link references accepted beside http(s) URLs unless the host names its own. */
export const DEFAULT_LINK_SCHEMES: readonly string[] = [
  "knowledge",
  "working",
  "vault",
  "linear",
  "slack",
  "github",
];

/**
 * The one link rule, for the tools and for imports alike: an http(s) URL or a `<scheme>:` reference, with no spaces
 * and no `<`, `>` or `|` (which a Slack label like `<https://a.example|https://b.example>` needs). `rule` says it in
 * words for the model.
 */
export function linkRule(schemes: readonly string[] = DEFAULT_LINK_SCHEMES): {
  test: (link: string) => boolean;
  rule: string;
} {
  const names = schemes.map((s) => s.replace(/[^a-z0-9-]/gi, "")).filter(Boolean);
  const prefix = names.length ? `(?:https?://|(?:${names.join("|")}):)` : "https?://";
  const pattern = new RegExp(`^${prefix}[^\\s<>|]+$`, "i");
  const refs = names.length ? ` or a ${names.map((n) => `${n}:`).join(" ")} reference` : "";
  return {
    test: (link) => link.length <= 512 && pattern.test(link),
    rule: `an http(s) URL${refs}; no spaces, <, > or |`,
  };
}

// What a wake needs of the opening turn's auth to send as it, and nothing else: no email or names at rest.
const KEPT_ATTRIBUTES = ["user_id", "team_id", "channel_id", "thread_ts"];

function deliveryPrincipal(auth: SessionAuthContext, keep: readonly string[]): SessionAuthContext {
  const attributes: Record<string, string | readonly string[]> = {};
  for (const key of keep) {
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
/** The store's file name, in one place for the store and the stats reader. */
export const STORE_FILE = "working.sqlite";
export const workingStorePath = (dir: string): string => join(dir, STORE_FILE);

const DAY = 24 * 60 * 60_000;
/** How long a lifted or replaced order stays listed as lifted, so the change that unblocks an action stays visible. */
const LIFTED_MS = 7 * DAY;
// A loop opened to wait on an event that fired this recently is due at once: one opened just after its event would
// otherwise wait for the next.
const RECENT_EVENT_MS = 10 * 60_000;
const PRUNE_EVERY_MS = 60 * 60_000;

// ----- the revisit grammar -----

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

/**
 * An order's subject as it's matched and stored: compatibility-normalised, invisible format characters removed,
 * whitespace collapsed, lowercased. Null when what's left isn't plain ASCII, since a lookalike letter (a Cyrillic о
 * for an o) would otherwise make a second "same" subject beside the first.
 */
function normalSubject(subject: string): string | null {
  const s = subject
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
  return s.length > 0 && /^[\x21-\x7e]+(?: [\x21-\x7e]+)*$/.test(s) ? s : null;
}

// ----- schema -----

// Additive only: each step runs once, in order, so a store written by an earlier version opens in a later one.
export const MIGRATIONS: readonly string[] = [
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
    due_at INTEGER,
    on_event TEXT,
    wake TEXT CHECK (wake IN ('pending', 'undeliverable')),
    wake_set_at INTEGER,
    lease_until INTEGER,
    lease_token TEXT,
    fired_by TEXT,
    wake_attempts INTEGER NOT NULL DEFAULT 0,
    wake_error TEXT,
    wake_seq INTEGER NOT NULL DEFAULT 0,
    fired_at INTEGER,
    status TEXT NOT NULL CHECK (status IN ('open', 'delivering', 'done', 'dropped')),
    why TEXT,
    review_by INTEGER NOT NULL,
    origin TEXT NOT NULL,
    last_edited_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    external_id TEXT UNIQUE
  );
  CREATE INDEX loops_open ON loops (conversation_key, due_at) WHERE status IN ('open', 'delivering');
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
  CREATE TABLE import_keys (
    external_id TEXT PRIMARY KEY
  );
  CREATE TABLE event_occurrences (
    event TEXT PRIMARY KEY,
    occurred_at INTEGER NOT NULL,
    fired_by TEXT NOT NULL
  );
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
let loopChanges = 0;
/** Order changes this process has logged: an order lifted or replaced by anyone but its setter. */
export const orderChangeCount = (): number => orderChanges;
const who = (o: Origin) => `${o.kind}${o.principalId ? `(${o.principalId})` : ""}`;

const newId = (prefix: string) => `${prefix}${randomBytes(4).toString("hex")}`;
// A bad time renders as unknown rather than throwing, so one odd row can't take a whole recall down.
const iso = (ms: number) => (Number.isFinite(ms) ? new Date(ms).toISOString() : "an unknown time");

/** How a loop's wake begins, which the host's instructions can name. */
export const LOOP_WAKE_OPENING = "A loop you opened is due";

/**
 * The wake's text, which the host posts as written: it names the loop, who opened it and who last changed it if that
 * was another kind of turn, and stands alone after a restart. Model text stays on one line, so it can't pose as a
 * recall block or a new instruction.
 */
export function followupNoteOf(
  loop: Pick<Loop, "id" | "what" | "next" | "links" | "createdAt" | "origin"> & {
    readonly lastEditedBy?: Origin | null;
  },
): string {
  const links = loop.links.length > 0 ? `\nLinks: ${loop.links.map(flat).join(" ")}` : "";
  const edited =
    loop.lastEditedBy && loop.lastEditedBy.kind !== loop.origin.kind
      ? `, last changed ${KIND[loop.lastEditedBy.kind]}`
      : "";
  return `${LOOP_WAKE_OPENING} (${loop.id}, opened ${iso(loop.createdAt).slice(0, 16)}Z ${KIND[loop.origin.kind]}${edited}): ${flat(loop.what)}\nNext: ${flat(loop.next)}${links}\nWhen it's done, close loop ${loop.id}; to come back to it again, update its revisit.`;
}

/**
 * The agent's working state, in one SQLite file. Every write is one IMMEDIATE transaction holding the entry and its
 * event together; a claim is one `UPDATE … RETURNING`, so two overlapping ticks can't both claim a loop.
 */
export class WorkingStore {
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  readonly #days: { loop: number; order: number; note: number };
  readonly #limits: { loops: number; orders: number; notes: number };
  readonly #eventsPerEntry: number;
  readonly #retentionMs: number;
  readonly #maxWakeAttempts: number;
  readonly #claimLimit: number;
  readonly #keep: readonly string[];
  readonly #link: (link: string) => boolean;
  #prunedAt = 0;
  /** True when the file could only be opened for reading: recall works, every write refuses. */
  readonly readOnly: boolean;

  constructor(path: string, options: WorkingStoreOptions = {}) {
    // Only the agent's own user reads its working state: its directory is 0700 when the agent owns it (a volume the
    // host made stays the host's to set), and a file it creates is 0600.
    const created = path !== ":memory:" && !existsSync(path);
    if (path !== ":memory:") {
      const dir = dirname(path);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        if (statSync(dir).uid === process.getuid?.()) chmodSync(dir, 0o700);
      } catch {
        // Not ours to change.
      }
    }
    this.#now = options.now ?? Date.now;
    this.#days = {
      loop: options.reviewAfterDays?.loop ?? 7,
      order: options.reviewAfterDays?.order ?? 14,
      note: options.reviewAfterDays?.note ?? 7,
    };
    this.#limits = {
      loops: options.limits?.loops ?? 200,
      orders: options.limits?.orders ?? 50,
      notes: options.limits?.notes ?? 100,
    };
    this.#eventsPerEntry = Math.max(2, options.eventsPerEntry ?? 50);
    this.#retentionMs = (options.retentionDays ?? 30) * DAY;
    this.#maxWakeAttempts = Math.max(1, options.maxWakeAttempts ?? 5);
    this.#claimLimit = Math.max(1, options.claimLimit ?? 20);
    this.#keep = options.principalAttributes ?? KEPT_ATTRIBUTES;
    this.#link = linkRule(options.linkSchemes).test;
    const opened = WorkingStore.#open(path, created);
    this.#db = opened.db;
    this.readOnly = opened.readOnly;
    if (!this.readOnly) {
      try {
        this.#migrate();
        this.#prune();
      } catch (error) {
        this.#db.close();
        throw error;
      }
    }
  }

  // A file the agent can't write (a read-only mount, another owner) is still read, so a hold stays visible; writes
  // then refuse. A store at an older schema can't be read that way, since it can't be migrated.
  static #open(path: string, created: boolean): { db: DatabaseSync; readOnly: boolean } {
    const db = new DatabaseSync(path);
    try {
      if (created) chmodSync(path, 0o600);
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("PRAGMA journal_mode = WAL");
      // A lock alone succeeds on a read-only file; only a write shows it, so write and roll back.
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec("CREATE TABLE IF NOT EXISTS write_probe (x)");
      } finally {
        if (db.isTransaction) db.exec("ROLLBACK");
      }
      return { db, readOnly: false };
    } catch (error) {
      db.close();
      if (!/readonly|read-only/i.test(String((error as Error).message))) throw error;
    }
    const ro = new DatabaseSync(path, { readOnly: true });
    try {
      ro.exec("PRAGMA busy_timeout = 5000");
      const { user_version } = ro.prepare("PRAGMA user_version").get() as { user_version: number };
      if (Number(user_version) !== MIGRATIONS.length)
        throw new Error(`read-only store at schema ${user_version}, not ${MIGRATIONS.length}`);
      return { db: ro, readOnly: true };
    } catch (error) {
      ro.close();
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

  // Closed loops, ended orders and expired notes past the retention window go, with their history; at most hourly.
  #prune(): void {
    if (this.readOnly) return;
    const now = this.#now();
    if (now - this.#prunedAt < PRUNE_EVERY_MS) return;
    this.#prunedAt = now;
    const cutoff = now - this.#retentionMs;
    this.#tx(() => {
      this.#db
        .prepare("DELETE FROM loops WHERE status IN ('done', 'dropped') AND updated_at < ?")
        .run(cutoff);
      this.#db
        .prepare("DELETE FROM orders WHERE status != 'active' AND updated_at < ?")
        .run(cutoff);
      this.#db.prepare("DELETE FROM notes WHERE expires_at < ?").run(cutoff);
      this.#db.exec(`DELETE FROM events WHERE
        (entry_kind = 'loop' AND entry_id NOT IN (SELECT id FROM loops)) OR
        (entry_kind = 'order' AND entry_id NOT IN (SELECT id FROM orders)) OR
        (entry_kind = 'note' AND entry_id NOT IN (SELECT id FROM notes))`);
      this.#db.prepare("DELETE FROM event_occurrences WHERE occurred_at < ?").run(cutoff);
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

  // A tool step eve retries runs its call again with the same call id; the entry it already made is the answer. Call
  // ids are unique only within a session, so the session is part of the key.
  #madeBy(table: Table, change: string, origin: Origin): Row | undefined {
    if (!origin.callId) return undefined;
    const e = this.#db
      .prepare(
        `SELECT entry_id FROM events WHERE entry_kind = ? AND change = ?
           AND json_extract(origin, '$.callId') = ? AND json_extract(origin, '$.sessionId') IS ?`,
      )
      .get(TABLE_KIND[table], change, origin.callId, origin.sessionId) as
      | { entry_id: string }
      | undefined;
    return e && this.#row(table, e.entry_id);
  }

  #count(sql: string, ...params: number[]): number {
    return Number((this.#db.prepare(sql).get(...params) as { n: number }).n);
  }

  // A delivering loop whose lease ran out has no live claimant: it counts as open again.
  #held(row: Row, now: number): boolean {
    return row.status === "delivering" && Number(row.lease_until ?? 0) > now;
  }

  // A new or changed revisit starts its attempts afresh: it's a new wake, not a retry of the old one.
  // Each arming gets a new sequence, so the host's idempotency key is unique per wake, not per loop and firing.
  #wake(revisit: Revisit | undefined | null, deliverable: boolean, now: number, before?: Row): Row {
    const fresh = { wake_attempts: 0, wake_error: null };
    if (!revisit || (revisit.dueAt === undefined && revisit.onEvent === undefined))
      return { due_at: null, on_event: null, wake: null, wake_set_at: null, ...fresh };
    // A recent occurrence counts, except the one that already fired this loop: re-arming on the same event after a
    // wake waits for the next occurrence instead of firing again at once.
    const firedAt = before?.fired_at == null ? null : Number(before.fired_at);
    const recent =
      revisit.onEvent === undefined
        ? undefined
        : (this.#db
            .prepare(
              "SELECT fired_by, occurred_at FROM event_occurrences WHERE event = ? AND occurred_at >= ? AND occurred_at > ?",
            )
            .get(revisit.onEvent, now - RECENT_EVENT_MS, firedAt ?? -1) as
            | { fired_by: string; occurred_at: number }
            | undefined);
    return {
      due_at: revisit.dueAt ?? (recent ? now : null),
      on_event: revisit.onEvent ?? null,
      wake: deliverable ? "pending" : "undeliverable",
      wake_set_at: now,
      wake_seq: Number(before?.wake_seq ?? 0) + 1,
      fired_by: recent?.fired_by ?? null,
      fired_at: recent ? Number(recent.occurred_at) : firedAt,
      ...fresh,
    };
  }

  /** Opens a loop in its conversation and answers it. */
  open(input: OpenInput, origin: Origin): Result<{ loop: Loop }> {
    this.#prune();
    const again = this.#madeBy("loops", "opened", origin);
    if (again) return { ok: true, loop: toLoop(again) };
    const now = this.#now();
    const open = this.#count(
      "SELECT count(*) AS n FROM loops WHERE status IN ('open', 'delivering')",
    );
    if (open >= this.#limits.loops)
      return {
        ok: false,
        reason: `There are already ${open} open loops, the most this agent keeps. Close the ones that are resolved or no longer worth doing (close), then open this one.`,
      };
    const row: Row = {
      id: newId("L"),
      conversation_key: addressKey(input.address),
      address: JSON.stringify(input.address),
      principal: input.principal
        ? JSON.stringify(deliveryPrincipal(input.principal, this.#keep))
        : null,
      what: input.what,
      waiting_on: input.waitingOn,
      next: input.next,
      links: JSON.stringify([...(input.links ?? [])]),
      fired_by: null,
      fired_at: null,
      wake_seq: 0,
      ...this.#wake(input.revisit, input.deliverable !== false, now),
      lease_until: null,
      lease_token: null,
      status: "open",
      why: null,
      review_by: input.reviewBy ?? now + this.#days.loop * DAY,
      origin: JSON.stringify(origin),
      last_edited_by: null,
      created_at: now,
      updated_at: now,
      external_id: null,
    };
    this.#tx(() => this.#put("loops", null, row, "opened", origin));
    return { ok: true, loop: toLoop(row) };
  }

  // Detection, not a gate: a loop changed from another kind of turn than opened it is logged with both origins and
  // counted, as an order change is, and the wake names who last changed it.
  #detectLoopChange(loop: Row, origin: Origin): void {
    const opened = JSON.parse(String(loop.origin)) as Origin;
    if (opened.kind === origin.kind) return;
    loopChanges++;
    console.warn(
      `[working] loop-change id=${loop.id} opened_by=${who(opened)} by=${who(origin)} count=${loopChanges}`,
    );
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
      const after: Row = {
        ...before,
        status: "open",
        lease_until: null,
        lease_token: null,
        waiting_on: input.waitingOn ?? before.waiting_on,
        next: input.next ?? before.next,
        links: input.links ? JSON.stringify([...input.links]) : before.links,
        ...(input.revisit !== undefined
          ? this.#wake(input.revisit, input.deliverable !== false, now, before)
          : {}),
        review_by: input.reviewBy ?? before.review_by,
        last_edited_by: JSON.stringify(origin),
        updated_at: now,
      };
      this.#put("loops", before, after, "updated", origin);
      this.#detectLoopChange(before, origin);
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
        last_edited_by: JSON.stringify(origin),
        updated_at: now,
      };
      this.#put("loops", before, after, "closed", origin);
      this.#detectLoopChange(before, origin);
      return { ok: true, loop: toLoop(after) };
    });
  }

  /** Sets the order on a subject. An active order on the same subject is replaced, and kept in history. */
  setOrder(
    input: { subject: string; rule: string; link: string; until?: number },
    origin: Origin,
  ): Result<{ order: Order; replaced: Order | null }> {
    const subject = normalSubject(input.subject);
    if (subject === null) return badSubject(input.subject);
    const again = this.#madeBy("orders", "set", origin);
    if (again) return { ok: true, order: toOrder(again), replaced: null };
    return this.#tx(() => {
      const now = this.#now();
      const id = newId("O");
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
    const normal = normalSubject(subject);
    if (normal === null) return badSubject(subject);
    return this.#tx(() => {
      const current = this.#activeOrder(normal);
      if (!current)
        return {
          ok: false,
          reason: `There's no active order on "${normal}". List orders to see the subjects that have one.`,
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
      .get(subject) as Row | undefined;
  }

  // Detection, not a gate: the counterpart of the graph's owner-overwrite line. An order lifted or replaced by anyone
  // other than whoever set it (another principal, or another kind of turn) is logged with both origins and a running
  // count, so an operator's hold lifted from a colleague's thread can be found.
  #detectOrderChange(order: Row, origin: Origin): void {
    const set = JSON.parse(String(order.origin)) as Origin;
    if (set.kind === origin.kind && set.principalId === origin.principalId) return;
    orderChanges++;
    console.warn(
      `[working] order-change subject=${JSON.stringify(order.subject)} set_by=${who(set)} by=${who(origin)} count=${orderChanges}`,
    );
  }

  /** Adds a note, which expires on its own. */
  addNote(input: { text: string; expiresAt?: number }, origin: Origin): Result<{ note: Note }> {
    const again = this.#madeBy("notes", "added", origin);
    if (again) return { ok: true, note: toNote(again) };
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
    return { ok: true, note: toNote(row) };
  }

  /**
   * Entries for one view, each kind capped at `limit` with its total: loops due or stale first, orders the operator set
   * first, then newest first, so the cap never hides what most needs seeing.
   */
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
      lifted: ["status != 'active' AND updated_at > ?", [now - LIFTED_MS]],
      all: ["status = 'active'", []],
    };
    const noteWhere: Partial<Record<ListView, Where>> = {
      notes: ["expires_at > ?", [now]],
      all: ["expires_at > ?", [now]],
    };
    const first: Record<Table, string> = {
      loops: `(wake IS NOT NULL AND due_at IS NOT NULL AND due_at <= ${Number(now)}) DESC, (review_by <= ${Number(now)}) DESC, `,
      orders: `(json_extract(origin, '$.kind') = 'operator') DESC, `,
      notes: "",
    };
    const select = (table: Table, where: Where | undefined) => {
      if (!where) return { rows: [] as Row[], total: 0 };
      const [clause, params] = where;
      const { n } = this.#db
        .prepare(`SELECT count(*) AS n FROM ${table} WHERE ${clause}`)
        .get(...params) as { n: number };
      const rows = this.#db
        .prepare(
          `SELECT * FROM ${table} WHERE ${clause} ORDER BY ${first[table]}updated_at DESC, id LIMIT ?`,
        )
        .all(...params, limit) as Row[];
      return { rows, total: Number(n) };
    };
    const loops = select("loops", loopWhere[filter.view]);
    const orders = select("orders", orderWhere[filter.view]);
    const notes = select("notes", noteWhere[filter.view]);
    return {
      loops: loops.rows.map(toLoop),
      orders: orders.rows.map(toOrder),
      notes: notes.rows.map(toNote),
      totals: { loops: loops.total, orders: orders.total, notes: notes.total },
    };
  }

  /**
   * Leases loops whose wake is due, however late, and isn't held by a live lease: at most `claimLimit`, oldest due
   * first. Each claim counts as an attempt, so a loop whose delivery crashes the host before it can settle or fail is
   * given up after `maxWakeAttempts`, not claimed forever. Delivery is at least once.
   */
  claimDue(now: number, leaseMs: number): ClaimedLoop[] {
    this.#prune();
    const token = randomBytes(8).toString("hex");
    return this.#tx(() => {
      const spent = this.#db
        .prepare(
          `UPDATE loops SET status = 'open', wake = 'undeliverable', lease_until = NULL, lease_token = NULL,
             wake_error = coalesce(wake_error, 'delivery never settled'), updated_at = ?
           WHERE wake = 'pending' AND wake_attempts >= ? AND status IN ('open', 'delivering')
             AND (lease_until IS NULL OR lease_until <= ?)
           RETURNING *`,
        )
        .all(now, this.#maxWakeAttempts, now) as Row[];
      for (const row of spent)
        this.#event("loops", String(row.id), "wake-given-up", null, row, WAKE_ORIGIN);
      const rows = this.#db
        .prepare(
          `UPDATE loops SET status = 'delivering', lease_until = ?, lease_token = ?,
             wake_attempts = wake_attempts + 1
           WHERE id IN (
             SELECT id FROM loops
             WHERE wake = 'pending' AND due_at IS NOT NULL AND due_at <= ?
               AND (lease_until IS NULL OR lease_until <= ?) AND status IN ('open', 'delivering')
             ORDER BY due_at, id LIMIT ?)
           RETURNING *`,
        )
        .all(now + leaseMs, token, now, now, this.#claimLimit) as Row[];
      // RETURNING keeps no order; hand them back oldest due first, as they were chosen.
      rows.sort(
        (a, b) => Number(a.due_at) - Number(b.due_at) || String(a.id).localeCompare(String(b.id)),
      );
      for (const row of rows)
        this.#event("loops", String(row.id), "wake-claimed", null, row, WAKE_ORIGIN);
      return rows.map((row) => {
        const loop = toLoop(row);
        return {
          id: loop.id,
          address: loop.address,
          conversationKey: loop.conversationKey,
          principal:
            row.principal === null
              ? null
              : (JSON.parse(String(row.principal)) as SessionAuthContext),
          followupNote: followupNoteOf(loop),
          dueAt: loop.dueAt,
          onEvent: loop.onEvent,
          firedBy: loop.firedBy,
          wakeSeq: Number(row.wake_seq ?? 0),
          leaseToken: token,
          createdAt: loop.createdAt,
        };
      });
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
   * The wake couldn't be handed off. A transient failure leaves the wake due, and the loop open for the agent to change,
   * to be claimed again once the lease runs out; a final one, or one at `maxWakeAttempts` claims, gives the wake up as
   * undeliverable, so the loop shows as due in the standing block instead of retrying forever. False when this
   * claimant no longer holds it.
   */
  failWake(
    id: string,
    leaseToken: string,
    failure: { readonly reason: string; readonly final?: boolean },
  ): boolean {
    return this.#tx(() => {
      const now = this.#now();
      const before = this.#row("loops", id);
      if (before?.status !== "delivering" || before.lease_token !== leaseToken) return false;
      const giveUp =
        failure.final === true || Number(before.wake_attempts ?? 0) >= this.#maxWakeAttempts;
      const after: Row = {
        ...before,
        status: "open",
        lease_token: null,
        lease_until: giveUp ? null : before.lease_until,
        wake: giveUp ? "undeliverable" : "pending",
        wake_error: clip(failure.reason, 160),
        updated_at: now,
      };
      this.#put("loops", before, after, giveUp ? "wake-given-up" : "wake-failed", WAKE_ORIGIN);
      return true;
    });
  }

  /**
   * An event happened at `occurredAt` (never later than `now`): every open loop waiting on it, whose wake was set by
   * then, becomes due `now`. One set after it waits for the next, so a redelivered old event wakes nothing new. The
   * wake's set time decides, not the loop's creation, since `update` can add a revisit to an old loop. The occurrence
   * is remembered, so a loop opened just after it is due at once. Answers how many became due.
   */
  eventOccurred(event: string, occurredAt: number, firedBy: string, now: number): number {
    if (!Number.isFinite(occurredAt) || !Number.isFinite(now)) return 0;
    // A far-future time would otherwise mark every later loop on this event as already fired.
    const at = Math.min(occurredAt, now);
    return this.#tx(() => {
      // Due: a loop armed by now, so one opened between the event and its recording isn't missed; but a loop armed
      // after an occurrence older than the recent window is a redelivery's, and waits; and no loop fires twice on the
      // same occurrence.
      const rows = this.#db
        .prepare(
          `UPDATE loops SET due_at = ?, fired_by = ?, fired_at = ?, updated_at = ?
           WHERE status = 'open' AND wake IS NOT NULL AND on_event = ? AND due_at IS NULL
             AND (wake_set_at <= ? OR (? >= ? AND wake_set_at <= ?))
             AND (fired_at IS NULL OR fired_at < ?)
           RETURNING *`,
        )
        .all(now, firedBy, at, now, event, at, at, now - RECENT_EVENT_MS, now, at) as Row[];
      this.#db
        .prepare(
          `INSERT INTO event_occurrences (event, occurred_at, fired_by) VALUES (?, ?, ?)
           ON CONFLICT (event) DO UPDATE SET occurred_at = excluded.occurred_at, fired_by = excluded.fired_by
           WHERE excluded.occurred_at > event_occurrences.occurred_at`,
        )
        .run(event, at, firedBy);
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

  /** Every recorded change to an entry still in history, oldest first. */
  history(id: string): EntryEvent[] {
    return (
      this.#db.prepare("SELECT * FROM events WHERE entry_id = ? ORDER BY seq").all(id) as Row[]
    ).map(toEvent);
  }

  /**
   * Undoes every change a session, turn, tool call or principal made: each entry it touched goes back to how it was
   * before its first such change still in history, and one it created is closed (a loop dropped, an order lifted, a
   * note expired). Nothing is deleted; the revert is itself an event. An empty filter reverts nothing. Answers how
   * many entries.
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
        const table: Table = KIND_TABLE[e.entry_kind as EntryEvent["entryKind"]];
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
   * Brings in a loop the host read from another store, once: a second call with the same `externalId` changes nothing
   * and answers "exists". The loop is stored as `open` would store it (text capped as the tools cap it, the sender auth
   * trimmed), with `createdAt` as when its wake was set, so an event that fired before it wakes nothing. A row with a
   * non-numeric time or an unknown status answers "bad"; an open one past the open-loop cap answers "capped".
   */
  importLoop(input: ImportedLoop): "imported" | "exists" | "bad" | "capped" {
    // A row the host read from elsewhere is checked here, so one bad row is refused alone, never rolling back others.
    // The same rules as open: a link the tools would refuse is refused here too.
    const time = (v: unknown) => v === null || v === undefined || Number.isFinite(v);
    const links = input.links ?? [];
    if (
      !Number.isFinite(input.createdAt) ||
      !time(input.wake?.dueAt) ||
      typeof input.what !== "string" ||
      typeof input.next !== "string" ||
      !["open", "done", "dropped"].includes(input.status) ||
      !addressSchema.safeParse(input.address).success ||
      typeof input.origin?.kind !== "string" ||
      !Array.isArray(links) ||
      links.length > 10 ||
      !links.every((l) => typeof l === "string" && this.#link(l))
    )
      return "bad";
    return this.#tx(() => {
      // The key outlives the loop: a closed import pruned after the retention window must not come back when the host
      // imports the same source again.
      if (this.#db.prepare("SELECT 1 FROM import_keys WHERE external_id = ?").get(input.externalId))
        return "exists";
      const now = this.#now();
      const open = input.status === "open";
      if (
        open &&
        this.#count("SELECT count(*) AS n FROM loops WHERE status IN ('open', 'delivering')") >=
          this.#limits.loops
      )
        return "capped";
      const hasWake = open && (input.wake?.dueAt != null || input.wake?.onEvent != null);
      const what = clip(input.what, 200) || "imported loop";
      const row: Row = {
        id: newId("L"),
        conversation_key: addressKey(input.address),
        address: JSON.stringify(input.address),
        principal: input.principal
          ? JSON.stringify(deliveryPrincipal(input.principal, this.#keep))
          : null,
        what,
        waiting_on: clip(input.waitingOn ?? "me", 40),
        next: clip(input.next, 500) || what,
        links: JSON.stringify([...(input.links ?? [])]),
        due_at: hasWake ? (input.wake?.dueAt ?? null) : null,
        on_event: hasWake ? (input.wake?.onEvent ?? null) : null,
        wake: hasWake ? "pending" : null,
        wake_set_at: hasWake ? input.createdAt : null,
        lease_until: null,
        lease_token: null,
        fired_by: input.wake?.firedBy ?? null,
        wake_attempts: 0,
        wake_error: null,
        wake_seq: hasWake ? 1 : 0,
        fired_at: null,
        status: input.status,
        why: open ? null : (input.why ?? "imported"),
        review_by: now + this.#days.loop * DAY,
        origin: JSON.stringify(input.origin),
        last_edited_by: null,
        created_at: input.createdAt,
        updated_at: now,
        external_id: input.externalId,
      };
      this.#put("loops", null, row, "imported", input.origin);
      this.#db.prepare("INSERT INTO import_keys (external_id) VALUES (?)").run(input.externalId);
      return "imported";
    });
  }
}

// Event rows keep attribution (the origin) but not the sender auth, which only the live loop needs for its wake.
const withoutPrincipal = (row: Row): Row => {
  const { principal: _, ...rest } = row;
  return rest;
};

const unknownLoop = (id: string): Refusal => ({
  ok: false,
  reason: `There's no loop ${id}. List loops to see their ids.`,
});
const delivering = (id: string): Refusal => ({
  ok: false,
  reason: `Loop ${id}'s wake is being delivered right now. Try again after it arrives.`,
});
const badSubject = (subject: string): Refusal => ({
  ok: false,
  reason: `"${flat(subject).slice(0, 80)}" isn't a subject I can keep: use plain letters, digits and punctuation, such as releases:web.`,
});

const str = (v: Row[string] | undefined) => (v === null || v === undefined ? null : String(v));
const num = (v: Row[string] | undefined) => (v === null || v === undefined ? null : Number(v));
const originOf = (v: Row[string] | undefined) => (v ? (JSON.parse(String(v)) as Origin) : null);

function toLoop(row: Row): Loop {
  return {
    id: String(row.id),
    status: row.status as LoopStatus,
    conversationKey: String(row.conversation_key),
    address: JSON.parse(String(row.address)) as Address,
    what: String(row.what),
    waitingOn: String(row.waiting_on),
    next: String(row.next),
    links: JSON.parse(String(row.links)) as string[],
    dueAt: num(row.due_at),
    onEvent: str(row.on_event),
    wake: str(row.wake) as WakeState | null,
    firedBy: str(row.fired_by),
    wakeAttempts: Number(row.wake_attempts ?? 0),
    wakeError: str(row.wake_error),
    why: str(row.why),
    reviewBy: Number(row.review_by),
    origin: JSON.parse(String(row.origin)) as Origin,
    lastEditedBy: originOf(row.last_edited_by),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toOrder(row: Row): Order {
  return {
    id: String(row.id),
    status: row.status as OrderStatus,
    subject: String(row.subject),
    rule: String(row.rule),
    link: String(row.link),
    until: num(row.until),
    why: str(row.why),
    reviewBy: Number(row.review_by),
    origin: JSON.parse(String(row.origin)) as Origin,
    endedBy: originOf(row.ended_by),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toNote(row: Row): Note {
  return {
    id: String(row.id),
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
    entryKind: row.entry_kind as EntryEvent["entryKind"],
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
  /** Run once the store is open, before it's returned: where a host imports loops from an earlier store. */
  readonly onFirstOpen?: (store: WorkingStore) => void;
}

/**
 * Opens the agent's store and runs the host's `onFirstOpen` on it. The provider and the host's wake engine both open
 * through here, so whichever opens first after a start runs it, and neither reads before it has run. A throw from it is
 * logged and the store opens anyway: a one-off import must not take working memory down.
 */
export function openWorkingStore(options: OpenWorkingStoreOptions): WorkingStore {
  const store = new WorkingStore(workingStorePath(options.dir), options);
  if (options.onFirstOpen !== undefined) {
    try {
      options.onFirstOpen(store);
    } catch (error) {
      console.warn(
        `[working] onFirstOpen failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return store;
}
