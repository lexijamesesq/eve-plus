import { isAbsolute } from "node:path";
import type { RouteHandlerArgs } from "eve/channels";
import type { SessionAuthContext } from "eve/context";
import { z } from "zod";
import type { Commissioner, Conversation } from "./types.js";
import type { WorkerConnector } from "./worker.js";

type To = RouteHandlerArgs["to"];

/** Where a notice for the commissioner goes: a channel the agent has, a target on it, and the auth to send as. */
export interface Delivery {
  channel: Parameters<To>[0];
  target: Parameters<To>[1];
  auth: SessionAuthContext;
}

export interface CommissioningConfig {
  /** Absolute directory for the ledger, on durable storage outside the sandbox. */
  dataDir: string;
  /** The ledger's subdirectory; one per mount. */
  namespace: string;
  /** The worker integration that receives the work, such as `cyrus(...)`. */
  worker: WorkerConnector;
  /** Whether a request to the worker endpoint comes from the worker. */
  authenticateWorker(request: Request): boolean | Promise<boolean>;
  /**
   * Who a session commissions as, and the conversation it's in, from its verified auth; `null` when it may not
   * commission. An owner can act on a commission only from the conversation it was opened in.
   */
  commissioner(auth: SessionAuthContext | null): Commissioner | null;
  /**
   * Where to tell the commissioner about a commission. The auth must map back, through `commissioner`, to the same
   * commissioner and conversation, so the delivered turn can answer; a delivery whose auth doesn't stays pending.
   */
  deliver(conversation: Conversation): Delivery;
  /** How long the worker may be quiet before the commissioner is told. Default: one minute. */
  overdueAfterMs?: number;
  /** The reconcile schedule's cron. Default: every minute. */
  reconcileCron?: string;
  /** The worker endpoint's path. Default: `/commissioning/mcp`. */
  mcpPath?: string;
}

const fn = z.custom<(...args: never[]) => unknown>((value) => typeof value === "function");
export const configSchema = z
  .object({
    dataDir: z.string().refine(isAbsolute, "dataDir must be absolute"),
    namespace: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    worker: z.object({ id: z.string().min(1).max(256), prepare: fn, handoff: fn }),
    authenticateWorker: fn,
    commissioner: fn,
    deliver: fn,
    overdueAfterMs: z.number().int().positive().optional(),
    reconcileCron: z.string().min(1).default("* * * * *"),
    mcpPath: z
      .string()
      .regex(/^\/(?!eve\/v1(?:\/|$))[a-zA-Z0-9/_-]+$/)
      .default("/commissioning/mcp"),
  })
  .strict() as unknown as z.ZodType<CommissioningConfig, CommissioningConfig>;
