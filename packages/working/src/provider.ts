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
  type ListView,
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
   * `delegated` for a delegated one, else `other`.
   */
  readonly originKind?: (auth: SessionAuthContext | null, session: OriginSession) => OriginKind;
  /** The event keys the host fires (through `eventOccurred`), which `revisit.on` may name. With none, `on` is refused. */
  readonly events?: readonly string[];
  /** Most open loops, active orders and live notes held at once. Defaults 200, 50, 100. */
  readonly limits?: { readonly loops?: number; readonly orders?: number; readonly notes?: number };
  /** Events kept per entry: its first, and its latest up to this many in all. Default 50. */
  readonly eventsPerEntry?: number;
  /** A follow-ups file to import, once, when the store is first opened; `conversation` places its rows. */
  readonly followups?: string;
  /** Max characters per recall message. Default 1,200. */
  readonly maxCharacters?: number;
  /** Days before an entry is marked stale. Defaults: loop 7, order 14, note 7 (a note expires then). */
  readonly reviewAfterDays?: {
    readonly loop?: number;
    readonly order?: number;
    readonly note?: number;
  };
  /** Days a lifted or replaced order stays in the standing block. Default 7. */
  readonly liftedVisibleDays?: number;
  /** Max write calls in one session, counting refused ones. Off by default. */
  readonly maxWritesPerSession?: number;
  /** The clock, for tests. */
  readonly now?: () => number;
}

// A schedule may send as a user's auth (a prep schedule sending as the operator), so the session's schedule marker
// decides first; the schedule principal covers a schedule sent as the app.
export function defaultOriginKind(
  auth: SessionAuthContext | null,
  session: OriginSession,
): OriginKind {
  if (session.schedule !== undefined || isScheduleAuth(auth)) return "scheduled";
  if (session.parent !== undefined) return "delegated";
  return "other";
}

const text = (max: number) => z.string().trim().min(1).max(max);
const when = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .describe('an ISO 8601 time with its offset, or "in N minutes|hours|days"');
const revisit = z
  .object({
    when: when.optional(),
    on: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .optional()
      .describe("an event to wait on, one of those this agent's host fires"),
  })
  .strict()
  .describe("when to come back to this loop: give `when` or `on`, not both");
// A link is shown to the model and may be shown to people, so only plain URLs and the reserved references pass: no
// spaces, and no `<`, `>` or `|`, which a Slack label like <https://a.example|https://b.example> would need.
const LINK =
  /^(?:https?:\/\/[^\s<>|]+|(?:knowledge|working|vault|linear|slack|github):[^\s<>|]+)$/i;
const link = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .regex(
    LINK,
    "a link is an http(s) URL or a knowledge:, working:, vault:, linear:, slack: or github: reference, with no spaces, <, > or |",
  );
const links = z
  .array(link)
  .max(10)
  .describe(
    "what anchors it: the message, PR, ticket or thread; each a URL or a reference: knowledge:<id>, working:<id>, vault:<path>, linear:<KEY-n>, slack:<channel>/<ts> or github:<owner>/<repo>#<n>",
  );
const id = z.string().trim().min(1).max(32);
const VIEWS = ["here", "elsewhere", "orders", "stale", "lifted", "notes", "all"] as const;

/**
 * The tools' descriptions and input schemas, keyed by tool name. eve qualifies each as `<slot>__<name>`. Exported so a
 * harness can show a model the same tools without an eve runtime.
 */
export const workingToolSpecs = {
  open: {
    description:
      "Open a loop: something you're waiting on or owe in this conversation, so it's in front of you every turn until you close it. Say what it is, whose move it is, and your next action, written to stand alone later. Give `revisit` to be woken in this conversation when it's due. The loop belongs to the conversation you're in, which comes from your session, not from anything you write. In a thread you started to ask someone else for help, a loop lands on, and wakes in, the conversation you asked from.",
    inputSchema: z
      .object({
        what: text(200).describe("one line: what's open"),
        waitingOn: text(40).describe("whose move it is: me, lexi, a colleague's name, or a system"),
        next: text(500).describe("the next action, in your words"),
        links: links.optional(),
        signature: text(120)
          .optional()
          .describe(
            "a recurring problem's key (check name plus distinctive behaviour), so a repeat is recognised",
          ),
        revisit: revisit.optional(),
        reviewBy: when.optional().describe("when it goes stale if untouched; default 7 days"),
      })
      .strict(),
  },
  update: {
    description:
      "Change an open loop: its next action, whose move it is, its links, its revisit (null removes it) or when it goes stale. Use the id from your working memory.",
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
    description:
      "Close a loop when it's resolved (done) or no longer worth doing (dropped), with why. Any revisit goes with it. History is kept.",
    inputSchema: z.object({ id, outcome: z.enum(["done", "dropped"]), why: text(500) }).strict(),
  },
  order: {
    description:
      "Record a standing order: a constraint on a subject you act on, such as a hold on releases:web, with a link to where it was set. A second order on the same subject replaces the first; history is kept.",
    inputSchema: z
      .object({
        subject: text(80).describe("what it constrains, e.g. releases:web"),
        rule: text(200).describe("the constraint, as you'll apply it"),
        link: link.describe(
          "where it was set: the message or comment, as a URL or a reference: knowledge:<id>, working:<id>, vault:<path>, linear:<KEY-n>, slack:<channel>/<ts> or github:<owner>/<repo>#<n>",
        ),
        until: when.optional().describe("when it ends on its own, if it does"),
      })
      .strict(),
  },
  lift: {
    description:
      "Lift the standing order on a subject, with why. It stays visible as lifted for a week, with who lifted it.",
    inputSchema: z.object({ subject: text(80), why: text(500) }).strict(),
  },
  note: {
    description:
      "Keep a short note that matters for the next few days across all your conversations. It expires on its own.",
    inputSchema: z
      .object({
        text: text(500),
        expires: when.optional().describe("when it expires; default 7 days"),
      })
      .strict(),
  },
  list: {
    description:
      "List your working memory beyond what each turn shows: loops here or elsewhere, standing orders, stale entries, recently lifted orders, notes, or all of it.",
    inputSchema: z.object({ view: z.enum(VIEWS).default("all") }).strict(),
  },
} as const;

type Ctx = Pick<ToolContext, "session" | "callId">;

/** An eve memory provider for the agent's working state. */
export function workingMemory(options: WorkingMemoryOptions): MemoryProvider {
  const now = options.now ?? Date.now;
  const maxCharacters = options.maxCharacters ?? 1_200;
  const originKind = options.originKind ?? defaultOriginKind;
  const events = options.events ?? [];

  // Opened on first use, so an agent with no volume still starts. A failed open isn't kept: the next turn retries,
  // so an outage is temporary, not sticky for the process.
  let store: WorkingStore | undefined;
  const get = (): WorkingStore => {
    if (store) return store;
    const opened = openWorkingStore({
      dir: options.dir,
      followups: options.followups,
      resolve: options.conversation,
      now,
      reviewAfterDays: options.reviewAfterDays,
      liftedVisibleDays: options.liftedVisibleDays,
      limits: options.limits,
      eventsPerEntry: options.eventsPerEntry,
    });
    store = opened;
    return store;
  };

  const addressOf = (auth: SessionAuthContext | null): Address | null => {
    const address = options.conversation(auth);
    return address === null ? null : addressSchema.parse(address);
  };

  const originOf = (ctx: Ctx): Origin => {
    const auth = ctx.session?.auth?.current ?? null;
    return {
      principalId: auth?.principalId ?? null,
      kind: originKind(auth, { schedule: ctx.session?.schedule, parent: ctx.session?.parent }),
      sessionId: ctx.session?.id ?? null,
      ...(ctx.session?.turn?.id ? { turnId: ctx.session.turn.id } : {}),
      ...(ctx.callId ? { callId: ctx.callId } : {}),
    };
  };

  // Writes per session, for maxWritesPerSession. Bounded: the oldest sessions drop out first.
  const writes = new Map<string, number>();
  const countWrite = (ctx: Ctx) => {
    const cap = options.maxWritesPerSession;
    const sessionId = ctx.session?.id;
    if (cap === undefined || sessionId === undefined) return;
    const n = (writes.get(sessionId) ?? 0) + 1;
    if (n > cap)
      throw new Error(
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
      const auth = context.session?.auth?.current ?? null;
      const address = addressOf(auth);
      const s = get();
      const key = address === null ? null : addressKey(address);
      const LIMIT = 30;
      const pick = (view: ListView) => s.list({ view, conversationKey: key, limit: LIMIT });
      const here = address === null ? null : pick("here");
      const orders = pick("orders");
      const lifted = pick("lifted");
      const notes = pick("notes");
      const elsewhere = pick("elsewhere");
      const view = {
        slot: context.memory.slot,
        now: now(),
        maxCharacters,
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
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[working] turn-start recall failed: ${reason}`);
      const outage = renderOutage(reason);
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
      const specs = workingToolSpecs;
      return {
        open: defineTool({
          ...specs.open,
          async execute(input, ctx: ToolContext) {
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
                signature: input.signature,
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
        }),
        update: defineTool({
          ...specs.update,
          async execute(input, ctx: ToolContext) {
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
        }),
        close: defineTool({
          ...specs.close,
          async execute(input, ctx: ToolContext) {
            countWrite(ctx);
            const r = get().closeLoop(input.id, input.outcome, input.why, originOf(ctx));
            if (!r.ok) return `Couldn't close loop ${input.id}: ${r.reason}`;
            return `Closed loop ${r.loop.id} as ${r.loop.status}.`;
          },
        }),
        order: defineTool({
          ...specs.order,
          async execute(input, ctx: ToolContext) {
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
        }),
        lift: defineTool({
          ...specs.lift,
          async execute(input, ctx: ToolContext) {
            countWrite(ctx);
            const r = get().liftOrder(input.subject, input.why, originOf(ctx));
            if (!r.ok) return `Couldn't lift it: ${r.reason}`;
            return `Lifted the order on ${r.order.subject}.`;
          },
        }),
        note: defineTool({
          ...specs.note,
          async execute(input, ctx: ToolContext) {
            countWrite(ctx);
            const expires = at(input.expires);
            if (expires.refused) return `Couldn't keep the note: expires ${expires.refused}.`;
            const r = get().addNote({ text: input.text, expiresAt: expires.at }, originOf(ctx));
            if (!r.ok) return `Couldn't keep the note: ${r.reason}`;
            return `Kept note ${r.note.id} until ${new Date(r.note.expiresAt).toISOString().slice(0, 10)}.`;
          },
        }),
        list: defineTool({
          ...specs.list,
          async execute(input, ctx: ToolContext) {
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
                    `${loopLine(l, t, l.conversationKey !== key)} (opened ${setByShort(l.origin)})`,
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
        }),
      };
    },
  });
}

const setByShort = (o: Origin) => `${o.kind}${o.principalId ? ` by ${o.principalId}` : ""}`;
