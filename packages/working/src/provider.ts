// @eve-plus/working — the eve glue: two recall messages every turn, and the working__* tools. The store stays behind.

import type { SessionAuthContext } from "eve/context";
import { defineMemoryProvider, type MemoryProvider } from "eve/memory";

import type { Address } from "./addresses.js";
import type { OriginKind } from "./store.js";

/** What the host knows about the turn beyond its auth, for classifying where a write came from. */
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
  /** The agents `revisit.on: deploy-completed:<agent>` may name. With none, `on` is refused. */
  readonly fleet?: readonly string[];
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

/** Recall message ids. Stable, so each turn's block replaces the last. */
export const HERE_ID = "working:here";
export const STANDING_ID = "working:standing";

/** An eve memory provider for the agent's working state. */
export function workingMemory(_options: WorkingMemoryOptions): MemoryProvider {
  return defineMemoryProvider({
    recall: {
      "turn.started": async () => ({
        messages: [
          { id: HERE_ID, content: "working memory unavailable: not implemented yet" },
          { id: STANDING_ID, content: "working memory unavailable: not implemented yet" },
        ],
      }),
    },
  });
}
