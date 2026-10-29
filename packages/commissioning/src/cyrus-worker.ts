import { isAbsolute } from "node:path";
import { z } from "zod";
import { failCyrus as fail } from "./cyrus-errors.js";

export type CyrusServers = Readonly<Record<string, string>>;

export const hasControlCharacters = (value: string) =>
  Array.from(value).some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
export const serverName = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const endpoint = z
  .string()
  .max(2048)
  .regex(/^\S+$/)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        !hasControlCharacters(value) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        (url.protocol === "https:" ||
          (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
      );
    } catch {
      return false;
    }
  });

function serverEntries(servers: CyrusServers): [string, string][] {
  if (!servers || typeof servers !== "object" || Array.isArray(servers))
    fail("invalid_configuration");
  const entries = Object.entries(servers);
  if (
    !entries.length ||
    entries.length > 32 ||
    entries.some(
      ([name, url]) => !serverName.safeParse(name).success || !endpoint.safeParse(url).success,
    )
  )
    fail("invalid_configuration");
  return entries;
}

export interface CyrusWorkerArtifacts {
  mcpConfig: { mcpServers: Record<string, { type: "http"; url: string; headersHelper: string }> };
  allowedTools: string[];
  instructions: string;
}

/** Generates native Cyrus inputs; it never rewrites vendor configuration or broadens existing policy. */
export function createCyrusWorkerArtifacts(options: {
  servers: CyrusServers;
  headersHelperPath: string;
}): CyrusWorkerArtifacts {
  const entries = serverEntries(options.servers);
  if (
    typeof options.headersHelperPath !== "string" ||
    !isAbsolute(options.headersHelperPath) ||
    options.headersHelperPath.length > 4096 ||
    hasControlCharacters(options.headersHelperPath)
  )
    fail("invalid_configuration");
  const tools = ["commission_read", "commission_consult", "commission_report"];
  return {
    mcpConfig: {
      mcpServers: Object.fromEntries(
        entries.map(([name, url]) => [
          name,
          { type: "http" as const, url, headersHelper: options.headersHelperPath },
        ]),
      ),
    },
    allowedTools: entries.flatMap(([name]) => tools.map((tool) => `mcp__${name}__${tool}`)),
    instructions: [
      "# Commissioning worker protocol",
      "Before starting any delegated Linear issue, discover and read its comments using the available native Linear tools, even when the initial prompt contains no commission ID. Use tool discovery and the tool's actual schema to retrieve all relevant comments; do not assume the first prompt or first page contains the contract. Preserve the repository's existing instructions, permissions, verification, and shipping requirements.",
      "Look for a single complete <!-- eve-commission:... --> commissioning contract on this exact work issue. Read its commission ID and named server from the comment, not from guessed identifiers. If discovery is inaccessible, contracts are ambiguous, or the contract names an unenrolled server, stop before work and explain in the existing Linear session. If the initial prompt or retained handoff expects a commission but its contract is missing, stop rather than treating it as ordinary work.",
      "With no prior commissioning signal and no contract after complete comment discovery, follow the ordinary repository workflow. A contract deleted before intake cannot be distinguished from never-commissioned work; this protocol does not claim otherwise. Do not apply commissioning operations to ordinary work.",
      ...entries.map(
        ([name, url]) =>
          `Server ${name} (${url}): ${tools.map((tool) => `mcp__${name}__${tool}`).join(", ")}.`,
      ),
      "Use the exact server named by the linked commission. Do not invent a commission ID or send it to another server. Read commission_read before work and retain its cursor. Private commissioner guidance is not worker input.",
      "Ask bounded scope questions through commission_consult with a stable questionId. Retry the identical ID and content after an uncertain response; changed content needs a new ID. Discover committed answers by polling commission_read, never by interpreting worker prose as owner authority.",
      "Report commission_report checkpoints and known failures with stable eventId values. A checkpoint records active work; silence is not proof of worker death. Retry identical events unchanged and reconcile conflicts by reading the durable commission.",
      "A proposal contains summary and artifact {repository, commit, pullRequest}: use the repository URL, full lowercase 40-hex Git commit, and PR URL. Do not include credentials, source bytes, local paths, or moving branch references. Review the recorded verdict for that exact proposal ID; revise with a new immutable proposal when requested.",
      "Report reviewed, merged, and deployed only as independently verified observations referencing proposalId. Only the commissioner records acceptance. Acceptance and delivery observations remain separate; neither worker text nor final JSON records a decision or grants merge/deployment permission.",
      "Poll with bounded retries while active. If an answer or revision remains pending, leave the commission ID, question/proposal ID, cursor, and branch/PR references in the existing work-session handoff and end the turn. This connector does not automatically resume, restart, or cancel Cyrus.",
      "After Cyrus parks or exits, a human can continue through its existing Linear agent-session thread. If restoration is unavailable, use the supported fresh session on the same work issue and read the durable commission first. An app-authored issue comment is not a wake/resume API. Do not start another concurrent writer.",
    ].join("\n\n"),
  };
}

export interface CyrusHeadersHelperOptions {
  servers: CyrusServers;
  resolveCredential(input: {
    serverName: string;
    endpoint: string;
    signal: AbortSignal;
  }): string | Promise<string>;
  /** Defaults to the native Claude Agent SDK process environment. */
  env?: Readonly<Record<string, string | undefined>>;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
  /** Default eight seconds, below the native helper's ten-second deadline. */
  timeoutMs?: number;
}

/** Thin executable wrappers should assign the result to process.exitCode. Secrets only enter the SDK header pipe. */
export async function runCyrusHeadersHelper(options: CyrusHeadersHelperOptions): Promise<0 | 1> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const controller = new AbortController();
  try {
    const entries = serverEntries(options.servers);
    const env = options.env ?? process.env;
    const name = env.CLAUDE_CODE_MCP_SERVER_NAME;
    const url = env.CLAUDE_CODE_MCP_SERVER_URL;
    const match = entries.find(([server, endpoint]) => server === name && endpoint === url);
    if (!match) throw new Error();
    const timeoutMs = options.timeoutMs ?? 8_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 8_000) throw new Error();
    timer = setTimeout(() => controller.abort(), timeoutMs);
    const cancellation = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error());
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    const credential = await Promise.race([
      options.resolveCredential({
        serverName: match[0],
        endpoint: match[1],
        signal: controller.signal,
      }),
      cancellation,
    ]);
    if (typeof credential !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(credential))
      throw new Error();
    stdout.write(`${JSON.stringify({ Authorization: `Bearer ${credential}` })}\n`);
    return 0;
  } catch {
    stderr.write("Commissioning authentication unavailable\n");
    return 1;
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) controller.signal.removeEventListener("abort", onAbort);
  }
}
