// @eve-plus/working — the eve glue: two recall messages every turn, and the working__* tools. The store stays behind.
// recall MUST NOT throw (a throwing recall fails the turn before the model call) and never returns nothing (eve keeps
// the previous block on an empty result, which would leave a stale block in place).

import type { SessionAuthContext } from "eve/context";
import {
  defineMemoryProvider,
  type MemoryOperationContext,
  type MemoryProvider,
  type MemoryRecallResult,
} from "eve/memory";
import { isScheduleAuth } from "eve/schedules";
import { defineTool, type ToolContext } from "eve/tools";
import { z } from "zod";

import { type Address, addressKey, addressSchema } from "./addresses.js";
import {
  describeAddress,
  HERE_ID,
  KIND,
  liftedLine,
  loopLine,
  noteLine,
  orderLine,
  renderHere,
  renderOutage,
  renderStanding,
  STANDING_ID,
} from "./render.js";
import {
  DEFAULT_LINK_SCHEMES,
  type ListView,
  linkRule,
  type Origin,
  type OriginKind,
  openWorkingStore,
  parseOn,
  parseWhen,
  type Revisit,
  type WorkingStore,
} from "./store.js";

export { HERE_ID, STANDING_ID } from "./render.js";

/** What the turn is beyond its auth, for classifying where a write came from. */
export interface OriginSession {
  readonly schedule?: unknown;
  readonly parent?: unknown;
}

export interface WorkingMemoryOptions {
  /** The store's directory; the file is `<dir>/working.sqlite`. A mounted volume in a container. */
  readonly dir: string;
  /** The conversation a turn belongs to, from its session auth; null when it has none (a schedule). */
  readonly conversation: (auth: SessionAuthContext | null) => Address | null;
  /** Whether the host can hand a loop's wake off at this address. Default: always. */
  readonly deliverable?: (address: Address) => boolean;
  /**
   * The kind of turn a write came from. Default: `scheduled` for a scheduled session or the schedule principal,
   * `delegated` for a delegated one, else `other`; only the host can say a turn is the operator's or a colleague's.
   */
  readonly originKind?: (auth: SessionAuthContext | null, session: OriginSession) => OriginKind;
  /** The event keys the host fires (through `eventOccurred`), which `revisit.on` may name. With none, `on` is refused. */
  readonly events?: readonly string[];
  /** The `<scheme>:` references a link may be, beside http(s) URLs; empty means URLs only. Default: knowledge, working, vault, linear, slack, github. */
  readonly linkSchemes?: readonly string[];
  /** Most open loops, active orders and live notes held at once. Defaults 200, 50, 100. */
  readonly limits?: { readonly loops?: number; readonly orders?: number; readonly notes?: number };
  /** Events kept per entry: its first, and its latest up to this many in all. Default 50. */
  readonly eventsPerEntry?: number;
  /** Days a closed loop, an ended order or an expired note is kept before it's pruned. Default 30. */
  readonly retentionDays?: number;
  /** The auth attributes a loop keeps for its wake. Default: user_id, team_id, channel_id, thread_ts. */
  readonly principalAttributes?: readonly string[];
  /**
   * Run when the provider opens the store, before it's first read: where a host imports loops from an earlier store.
   * The wake engine runs it on its own open too, so it must be idempotent, as importLoop is.
   */
  readonly onFirstOpen?: (store: WorkingStore) => void;
  /** Max characters per recall message. Default 1,200. */
  readonly maxCharacters?: number;
  /** Days before an entry is marked stale. Defaults: loop 7, order 14, note 7 (a note expires then). */
  readonly reviewAfterDays?: {
    readonly loop?: number;
    readonly order?: number;
    readonly note?: number;
  };
  /** Max write calls in one session, counting refused ones; past it a write throws. Default 100. */
  readonly maxWritesPerSession?: number;
  /** The clock, for tests. */
  readonly now?: () => number;
}

// A schedule may send as a user's auth, so the session's schedule marker decides first; the schedule principal covers
// a schedule sent as the app.
function defaultOriginKind(auth: SessionAuthContext | null, session: OriginSession): OriginKind {
  if (session.schedule !== undefined || isScheduleAuth(auth)) return "scheduled";
  if (session.parent !== undefined) return "delegated";
  return "other";
}

const text = (max: number) => z.string().trim().min(1).max(max);
const when = z.string().trim().min(1).max(64);
const id = z.string().trim().min(1).max(32);
const VIEWS = ["here", "elsewhere", "orders", "stale", "lifted", "notes", "all"] as const;

/**
 * The tools' descriptions and input schemas for a set of link schemes, keyed by tool name; eve qualifies each as
 * `<slot>__<name>`. A link is shown to the model and may be shown to people, so only http(s) URLs and the schemes
 * pass, with no spaces and no `<`, `>` or `|` (which a Slack label like `<https://a.example|https://b.example>` needs).
 */
export function toolSpecs(schemes: readonly string[] = DEFAULT_LINK_SCHEMES) {
  const { test, rule } = linkRule(schemes);
  // Checked by refine, not a schema pattern, so the rule is stated once in words rather than in every tool's schema.
  const link = z.string().trim().min(1).max(512).refine(test, `a link is ${rule}`);
  const links = z.array(link).max(10);
  const revisit = z
    .object({
      when: when.optional(),
      on: text(64).optional().describe("an event key the host fires"),
    })
    .strict()
    .describe("wake you here at `when` or `on` an event");
  return {
    open: {
      description: `Open a loop in this conversation: something you're waiting on or owe. It shows every turn until closed; write it to stand alone. The conversation is the one your host resolves for this turn. Times: ISO 8601 with offset, or "in N minutes|hours|days". Links: ${rule}.`,
      inputSchema: z
        .object({
          what: text(200),
          waitingOn: text(40).describe("whose move: me, a person, a system"),
          next: text(500).describe("your next action"),
          links: links.optional(),
          revisit: revisit.optional(),
          reviewBy: when.optional().describe("default 7 days"),
        })
        .strict(),
    },
    update: {
      description: "Change an open loop; rules as in open. revisit null removes it.",
      inputSchema: z
        .object({
          id,
          next: text(500).optional(),
          waitingOn: text(40).optional(),
          links: links.optional(),
          revisit: revisit.nullable().optional(),
          reviewBy: when.optional(),
        })
        .strict(),
    },
    close: {
      description: "Close a loop as done or dropped, with why. Its revisit goes with it.",
      inputSchema: z.object({ id, outcome: z.enum(["done", "dropped"]), why: text(500) }).strict(),
    },
    order: {
      description:
        "Set a standing order: a constraint on a subject you act on (e.g. releases:web), linked (rules as in open) to where it was set. It replaces any order on that subject.",
      inputSchema: z
        .object({ subject: text(80), rule: text(200), link, until: when.optional() })
        .strict(),
    },
    lift: {
      description:
        "Lift a subject's standing order, with why. It shows as lifted for 7 days, with who lifted it.",
      inputSchema: z.object({ subject: text(80), why: text(500) }).strict(),
    },
    note: {
      description:
        "Keep a short note for all your conversations; it expires (default 7 days). Loop details go in update.",
      inputSchema: z.object({ text: text(500), expires: when.optional() }).strict(),
    },
    list: {
      description: "List working memory in full: one view, or all.",
      inputSchema: z.object({ view: z.enum(VIEWS).default("all") }).strict(),
    },
  } as const;
}

/**
 * The default tools' descriptions and input schemas, for an eval harness that shows a model the same tools without
 * an eve runtime.
 */
export const workingToolSpecs = toolSpecs();

type Ctx = Pick<ToolContext, "session" | "callId">;

class WriteLimitError extends Error {}

const UNAVAILABLE =
  "Working memory is temporarily unavailable this turn; nothing was recorded. Act on what you can see, and say so if it matters.";
const reasonOf = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 160);

/** An eve memory provider for the agent's working state. */
export function workingMemory(options: WorkingMemoryOptions): MemoryProvider {
  const now = options.now ?? Date.now;
  const maxCharacters = options.maxCharacters ?? 1_200;
  const originKind = options.originKind ?? defaultOriginKind;
  const events = options.events ?? [];
  const specs = toolSpecs(options.linkSchemes);
  const orderCap = Math.min(options.limits?.orders ?? 50, 200);

  // Opened on first use, so an agent with no volume still starts. A failed open isn't kept: the next turn retries,
  // so an outage is temporary, not sticky for the process.
  let store: WorkingStore | undefined;
  const get = (): WorkingStore => {
    store ??= openWorkingStore({
      dir: options.dir,
      onFirstOpen: options.onFirstOpen,
      now,
      reviewAfterDays: options.reviewAfterDays,
      limits: options.limits,
      eventsPerEntry: options.eventsPerEntry,
      retentionDays: options.retentionDays,
      principalAttributes: options.principalAttributes,
      linkSchemes: options.linkSchemes,
    });
    return store;
  };

  // One store for the whole agent, whatever scope eve resolves; a host whose scope changes is told once, since the
  // loops would otherwise seem to follow a scope they don't.
  let scope: string | undefined;
  const checkScope = (key: string) => {
    if (scope === undefined) scope = key;
    else if (key !== scope) {
      console.warn(
        `[working] working memory is agent-wide; scope changed from ${scope} to ${key}, serving the same store`,
      );
      scope = key;
    }
  };

  const addressOf = (auth: SessionAuthContext | null): Address | null => {
    const address = options.conversation(auth);
    return address === null ? null : addressSchema.parse(address);
  };

  const originOf = (ctx: Ctx): Origin => {
    const auth = ctx.session?.auth?.current ?? null;
    const turn = ctx.session?.turn;
    return {
      principalId: auth?.principalId ?? null,
      kind: originKind(auth, { schedule: ctx.session?.schedule, parent: ctx.session?.parent }),
      sessionId: ctx.session?.id ?? null,
      ...(turn?.id ? { turnId: turn.id } : {}),
      ...(typeof turn?.sequence === "number" ? { turnSequence: turn.sequence } : {}),
      ...(ctx.callId ? { callId: ctx.callId } : {}),
    };
  };

  // A store failure inside a tool comes back to the model as fixed text, its reason to the log only; the write cap
  // alone still throws, so a runaway run fails loudly.
  const safely =
    <A extends unknown[]>(fn: (...args: A) => Promise<string>) =>
    async (...args: A): Promise<string> => {
      try {
        return await fn(...args);
      } catch (error) {
        if (error instanceof WriteLimitError) throw error;
        console.warn(`[working] tool failed: ${reasonOf(error)}`);
        return UNAVAILABLE;
      }
    };

  // Writes per session, for maxWritesPerSession. Bounded: the oldest sessions drop out first.
  const writes = new Map<string, number>();
  const countWrite = (ctx: Ctx) => {
    const cap = options.maxWritesPerSession ?? 100;
    const sessionId = ctx.session?.id;
    if (sessionId === undefined) return;
    const n = (writes.get(sessionId) ?? 0) + 1;
    if (n > cap)
      throw new WriteLimitError(
        `This session has reached its working-memory write limit (${cap}). No more working-memory writes are possible in it.`,
      );
    writes.delete(sessionId);
    writes.set(sessionId, n);
    if (writes.size > 1_000) writes.delete(writes.keys().next().value as string);
  };

  const at = (value: string | undefined): { at?: number; refused?: string } => {
    if (value === undefined) return {};
    const r = parseWhen(value, now());
    return "at" in r ? { at: r.at } : { refused: r.refused };
  };
  const revisitOf = (r: { when?: string; on?: string }): Revisit | { refused: string } => {
    if (r.when !== undefined && r.on !== undefined)
      return { refused: "give `when` or `on` for a revisit, not both" };
    if (r.when !== undefined) {
      const t = at(r.when);
      return t.refused !== undefined ? { refused: t.refused } : { dueAt: t.at };
    }
    if (r.on !== undefined) {
      const e = parseOn(r.on, events);
      return "event" in e ? { onEvent: e.event } : { refused: e.refused };
    }
    return { refused: "a revisit needs `when` (a time) or `on` (an event)" };
  };

  const recall = async (context: MemoryOperationContext): Promise<MemoryRecallResult> => {
    try {
      checkScope(context.memory.scope.key);
      const auth = context.session?.auth?.current ?? null;
      // A resolver that fails costs this turn its `here`, not its holds: standing doesn't depend on the conversation.
      let address: Address | null;
      try {
        address = addressOf(auth);
      } catch (error) {
        console.warn(`[working] conversation resolver failed: ${reasonOf(error)}`);
        address = null;
      }
      const s = get();
      const key = address === null ? null : addressKey(address);
      const pick = (view: ListView, limit = 30) => s.list({ view, conversationKey: key, limit });
      const here = address === null ? null : pick("here");
      // Every active order is fetched, so the block can name each one even when it can't show it.
      const orders = pick("orders", orderCap);
      const lifted = pick("lifted");
      const notes = pick("notes");
      const elsewhere = pick("elsewhere");
      const view = {
        slot: context.memory.slot,
        now: now(),
        maxCharacters,
        readOnly: s.readOnly,
        here: here && { loops: here.loops, total: here.totals.loops },
        orders: { orders: orders.orders, total: orders.totals.orders },
        lifted: { orders: lifted.orders, total: lifted.totals.orders },
        notes: { notes: notes.notes, total: notes.totals.notes },
        elsewhere: { loops: elsewhere.loops, total: elsewhere.totals.loops },
      };
      return {
        messages: [
          { id: HERE_ID, content: renderHere(view) },
          { id: STANDING_ID, content: renderStanding(view) },
        ],
      };
    } catch (error) {
      // Never throw, never fall silent: an unreadable store must not look like an empty one.
      console.warn(`[working] turn-start recall failed: ${reasonOf(error)}`);
      const outage = renderOutage(context.memory?.slot ?? "working");
      return {
        messages: [
          { id: HERE_ID, content: outage.here },
          { id: STANDING_ID, content: outage.standing },
        ],
      };
    }
  };

  return defineMemoryProvider({
    recall: { "turn.started": recall },
    async tools(context) {
      const slot = context.memory.slot;
      return {
        open: defineTool({
          ...specs.open,
          execute: safely(
            async (input: z.infer<typeof specs.open.inputSchema>, ctx: ToolContext) => {
              countWrite(ctx);
              const address = addressOf(ctx.session?.auth?.current ?? null);
              if (address === null)
                return "Couldn't open the loop: this turn has no conversation of its own (a scheduled run, say). Open it from the conversation it belongs to.";
              const wake = input.revisit ? revisitOf(input.revisit) : undefined;
              if (wake && "refused" in wake) return `Couldn't open the loop: ${wake.refused}.`;
              const review = at(input.reviewBy);
              if (review.refused) return `Couldn't open the loop: reviewBy ${review.refused}.`;
              const deliverable = wake ? (options.deliverable?.(address) ?? true) : true;
              const r = get().open(
                {
                  address,
                  principal: ctx.session?.auth?.current ?? null,
                  what: input.what,
                  waitingOn: input.waitingOn,
                  next: input.next,
                  links: input.links,
                  reviewBy: review.at,
                  revisit: wake,
                  deliverable,
                },
                originOf(ctx),
              );
              if (!r.ok) return `Couldn't open the loop: ${r.reason}`;
              const woken = !wake
                ? ""
                : deliverable
                  ? " You'll be woken here when its revisit is due."
                  : ` Its revisit is recorded, but a wake can't be delivered to ${describeAddress(address)}; the loop will still show as due in ${STANDING_ID} when the time comes.`;
              return `Opened loop ${r.loop.id} in this conversation.${woken}`;
            },
          ),
        }),
        update: defineTool({
          ...specs.update,
          execute: safely(
            async (input: z.infer<typeof specs.update.inputSchema>, ctx: ToolContext) => {
              countWrite(ctx);
              const s = get();
              let wake: Revisit | null | undefined;
              let deliverable = true;
              if (input.revisit === null) wake = null;
              else if (input.revisit !== undefined) {
                const w = revisitOf(input.revisit);
                if ("refused" in w) return `Couldn't update loop ${input.id}: ${w.refused}.`;
                wake = w;
                const loop = s.loop(input.id);
                if (loop) deliverable = options.deliverable?.(loop.address) ?? true;
              }
              const review = at(input.reviewBy);
              if (review.refused)
                return `Couldn't update loop ${input.id}: reviewBy ${review.refused}.`;
              const r = s.update(
                input.id,
                {
                  next: input.next,
                  waitingOn: input.waitingOn,
                  links: input.links,
                  revisit: wake,
                  deliverable,
                  reviewBy: review.at,
                },
                originOf(ctx),
              );
              if (!r.ok) return `Couldn't update loop ${input.id}: ${r.reason}`;
              return `Updated loop ${r.loop.id}.${wake && !deliverable ? ` Its revisit is recorded, but a wake can't be delivered there; it will show as due in ${STANDING_ID}.` : ""}`;
            },
          ),
        }),
        close: defineTool({
          ...specs.close,
          execute: safely(
            async (input: z.infer<typeof specs.close.inputSchema>, ctx: ToolContext) => {
              countWrite(ctx);
              const r = get().closeLoop(input.id, input.outcome, input.why, originOf(ctx));
              if (!r.ok) return `Couldn't close loop ${input.id}: ${r.reason}`;
              return `Closed loop ${r.loop.id} as ${r.loop.status}.`;
            },
          ),
        }),
        order: defineTool({
          ...specs.order,
          execute: safely(
            async (input: z.infer<typeof specs.order.inputSchema>, ctx: ToolContext) => {
              countWrite(ctx);
              const until = at(input.until);
              if (until.refused) return `Couldn't record the order: until ${until.refused}.`;
              const r = get().setOrder(
                { subject: input.subject, rule: input.rule, link: input.link, until: until.at },
                originOf(ctx),
              );
              if (!r.ok) return `Couldn't record the order: ${r.reason}`;
              return r.replaced
                ? `Recorded the order on ${r.order.subject}; it replaces "${r.replaced.rule}".`
                : `Recorded the order on ${r.order.subject}.`;
            },
          ),
        }),
        lift: defineTool({
          ...specs.lift,
          execute: safely(
            async (input: z.infer<typeof specs.lift.inputSchema>, ctx: ToolContext) => {
              countWrite(ctx);
              const r = get().liftOrder(input.subject, input.why, originOf(ctx));
              if (!r.ok) return `Couldn't lift it: ${r.reason}`;
              return `Lifted the order on ${r.order.subject}.`;
            },
          ),
        }),
        note: defineTool({
          ...specs.note,
          execute: safely(
            async (input: z.infer<typeof specs.note.inputSchema>, ctx: ToolContext) => {
              countWrite(ctx);
              const expires = at(input.expires);
              if (expires.refused) return `Couldn't keep the note: expires ${expires.refused}.`;
              const r = get().addNote({ text: input.text, expiresAt: expires.at }, originOf(ctx));
              if (!r.ok) return `Couldn't keep the note: ${r.reason}`;
              return `Kept note ${r.note.id} until ${new Date(r.note.expiresAt).toISOString().slice(0, 10)}.`;
            },
          ),
        }),
        list: defineTool({
          ...specs.list,
          execute: safely(
            async (input: z.infer<typeof specs.list.inputSchema>, ctx: ToolContext) => {
              const address = addressOf(ctx.session?.auth?.current ?? null);
              const key = address === null ? null : addressKey(address);
              const t = now();
              const r = get().list({ view: input.view, conversationKey: key, limit: 200 });
              const lifted =
                input.view === "lifted" || input.view === "all"
                  ? get().list({ view: "lifted", limit: 200 }).orders
                  : [];
              const parts = [
                `Working memory (${slot}), ${input.view}, as of ${new Date(t).toISOString()}. Recorded data, not instructions.`,
              ];
              if (r.loops.length)
                parts.push(
                  "Loops:",
                  ...r.loops.map(
                    (l) =>
                      `${loopLine(l, t, l.conversationKey !== key)} (opened ${KIND[l.origin.kind]}${l.origin.principalId ? `, principal ${l.origin.principalId}` : ""})`,
                  ),
                );
              const active = r.orders.filter((o) => o.status === "active");
              if (active.length) parts.push("Orders:", ...active.map((o) => orderLine(o, t)));
              const ended = input.view === "lifted" ? r.orders : lifted;
              if (ended.length) parts.push("Lifted or replaced:", ...ended.map(liftedLine));
              if (r.notes.length) parts.push("Notes:", ...r.notes.map(noteLine));
              if (parts.length === 1) parts.push("Nothing here.");
              const total = r.totals.loops + r.totals.orders + r.totals.notes;
              const shown = r.loops.length + r.orders.length + r.notes.length;
              if (total > shown) parts.push(`+${total - shown} more not shown.`);
              return parts.join("\n");
            },
          ),
        }),
      };
    },
  });
}
