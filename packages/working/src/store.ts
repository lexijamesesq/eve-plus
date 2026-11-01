// The working store: loops, orders and notes in one SQLite file per agent, with every change kept as an attributed
// event. The host's wake engine drives loops' wakes through claimDue / settleWake / releaseWake / eventOccurred.

import type { SessionAuthContext } from "eve/context";

import type { Address } from "./addresses.js";

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

/** One recorded change to an entry. */
export interface EntryEvent {
  readonly seq: number;
  readonly entryKind: Entry["kind"];
  readonly entryId: string;
  readonly change: string;
  readonly before: unknown;
  readonly after: unknown;
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

export interface ListFilter {
  readonly view: "here" | "elsewhere" | "orders" | "stale" | "lifted" | "notes" | "all";
  readonly conversationKey?: string | null;
  readonly limit?: number;
}

export interface Listing {
  readonly loops: readonly Loop[];
  readonly orders: readonly Order[];
  readonly notes: readonly Note[];
  /** How many matched before `limit`. */
  readonly total: number;
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
  readonly reviewAfterDays?: {
    readonly loop?: number;
    readonly order?: number;
    readonly note?: number;
  };
}

/** The store's file inside its directory. */
export const workingStorePath = (dir: string): string => `${dir}/working.sqlite`;

const pending = (): never => {
  throw new Error("not implemented yet");
};

/** The agent's working state, in one SQLite file. */
export class WorkingStore {
  constructor(_path: string, _options: WorkingStoreOptions = {}) {}

  open(_input: OpenInput, _origin: Origin): Result<{ loop: Loop }> {
    return pending();
  }
  update(_id: string, _input: UpdateInput, _origin: Origin): Result<{ loop: Loop }> {
    return pending();
  }
  closeLoop(
    _id: string,
    _outcome: "done" | "dropped",
    _why: string,
    _origin: Origin,
  ): Result<{ loop: Loop }> {
    return pending();
  }
  setOrder(
    _input: { subject: string; rule: string; link: string; until?: number },
    _origin: Origin,
  ): Result<{ order: Order; replaced: Order | null }> {
    return pending();
  }
  liftOrder(_subject: string, _why: string, _origin: Origin): Result<{ order: Order }> {
    return pending();
  }
  addNote(_input: { text: string; expiresAt?: number }, _origin: Origin): Result<{ note: Note }> {
    return pending();
  }
  list(_filter: ListFilter): Listing {
    return pending();
  }
  claimDue(_now: number, _leaseMs: number): ClaimedLoop[] {
    return pending();
  }
  settleWake(_id: string, _leaseToken: string, _firedBy: string): boolean {
    return pending();
  }
  releaseWake(_id: string, _leaseToken: string): boolean {
    return pending();
  }
  /**
   * Makes due now every pending loop waiting on `event` that was opened by `occurredAt`; answers how many. A loop
   * opened later waits for the next one, so a redelivered old event wakes nothing new.
   */
  eventOccurred(_event: string, _occurredAt: number, _firedBy: string, _now: number): number {
    return pending();
  }
  history(_id: string): EntryEvent[] {
    return pending();
  }
  revertBatch(_filter: RevertFilter, _origin: Origin): number {
    return pending();
  }
  migrateFollowups(
    _path: string,
    _resolve: (principal: SessionAuthContext) => Address | null,
  ): MigrationReport {
    return pending();
  }
  /** Closes the database. */
  close(): void {}
}

/** When `when` falls, in epoch ms, or why it can't be scheduled. */
export function parseWhen(_when: string, _now: number): { at: number } | { refused: string } {
  return pending();
}

/** The event key `on` names, or why it isn't one. */
export function parseOn(
  _on: string,
  _fleet: readonly string[],
): { event: string } | { refused: string } {
  return pending();
}
