import { isAbsolute } from "node:path";
import type { SessionAuthContext } from "eve/context";
import { z } from "zod";
import type { Caller } from "./types.js";

export interface CommissioningConfig {
  /** Durable application storage; never a sandbox path or ephemeral deployment filesystem. */
  dataDir: string;
  namespace: string;
  workerPrincipalId: string;
  authenticateWorker(request: Request): Caller | null | Promise<Caller | null>;
  resolveSessionPrincipal(auth: SessionAuthContext | null): Caller | null;
  resolveDeliveryAuth(
    principalId: string,
  ): SessionAuthContext | null | Promise<SessionAuthContext | null>;
  overdueAfterMs?: number;
  reconcileCron?: string;
  mcpPath?: string;
}
const fn = z.custom<(...args: never[]) => unknown>((value) => typeof value === "function");
export const configSchema = z
  .object({
    dataDir: z.string().refine(isAbsolute, "dataDir must be absolute"),
    namespace: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    workerPrincipalId: z.string().min(1).max(256),
    authenticateWorker: fn,
    resolveSessionPrincipal: fn,
    resolveDeliveryAuth: fn,
    overdueAfterMs: z.number().int().positive().optional(),
    reconcileCron: z.string().min(1).default("* * * * *"),
    mcpPath: z
      .string()
      .regex(/^\/(?!eve\/v1(?:\/|$))[a-zA-Z0-9/_-]+$/)
      .default("/commissioning/mcp"),
  })
  .strict() as unknown as z.ZodType<CommissioningConfig, CommissioningConfig>;

export function verified(caller: Caller | null | undefined): Caller {
  if (
    caller?.verified !== true ||
    typeof caller.principalId !== "string" ||
    !caller.principalId.trim()
  ) {
    throw new Error("Verified commissioning identity required");
  }
  return { verified: true, principalId: caller.principalId };
}
