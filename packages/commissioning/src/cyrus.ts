import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { callLinearGraphQL } from "eve/channels/linear";
import { z } from "zod";
import type { WorkerConnector } from "./worker.js";

const reasons = {
  invalid_configuration: "Invalid Cyrus connector configuration",
  invalid_reference: "A Linear issue reference is required",
  invalid_binding: "Invalid Cyrus work binding",
  contract_too_large: "The Cyrus commissioning contract exceeds the supported size",
  configuration_changed: "Cyrus configuration differs from the recorded work binding",
  work_unavailable: "The canonical Linear work record is unavailable",
  handoff_conflict: "The Linear work record conflicts with this commission",
  handoff_unconfirmed: "The Cyrus handoff is not confirmed",
  provider_unavailable: "The Linear provider is unavailable",
  cancelled: "The Cyrus request was cancelled",
  timeout: "The Cyrus request timed out",
} as const;

export class CyrusConnectorError extends Error {
  constructor(public readonly code: keyof typeof reasons) {
    super(reasons[code]);
    this.name = "CyrusConnectorError";
  }
}

export interface CyrusOptions {
  linear: {
    accessToken: string | (() => string | Promise<string>);
    /** Standard fetch injection; the default uses Linear's public GraphQL endpoint. */
    fetch?: typeof fetch;
    signal?: AbortSignal;
  };
  delegateId: string;
  mcp: { serverName: string; endpoint: string };
  /** Deadline for each complete provider operation, including token resolution. Default: 15 seconds. */
  timeoutMs?: number;
}

/** Native MCP server name to exact worker-reachable HTTP endpoint. */
export type CyrusServers = Readonly<Record<string, string>>;

const hasControlCharacters = (value: string) =>
  Array.from(value).some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
const identifier = z
  .string()
  .min(1)
  .max(256)
  .regex(/^\S+$/)
  .refine((value) => !hasControlCharacters(value));
const serverName = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const endpoint = z
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
const issueUrl = z
  .string()
  .max(2048)
  .regex(/^\S+$/)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        !hasControlCharacters(value) &&
        url.origin === "https://linear.app" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  });
const bindingSchema = z
  .object({
    version: z.literal("2"),
    contractCommentId: z
      .string()
      .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    commissionId: identifier,
    issueId: identifier,
    issueUrl,
    delegateId: identifier,
    mcpServerName: serverName,
    mcpEndpoint: endpoint,
  })
  .strict();
const maxContractCharacters = 1_048_576;
const recordSchema = z.object({
  id: identifier,
  url: issueUrl,
  description: z.string().max(1_048_576).nullable(),
  delegate: z.object({ id: identifier }).nullable(),
  comments: z.object({
    nodes: z
      .array(z.object({ id: identifier, body: z.string().max(maxContractCharacters) }))
      .max(2),
    pageInfo: z.object({ hasNextPage: z.boolean() }),
  }),
});

function fail(code: keyof typeof reasons): never {
  throw new CyrusConnectorError(code);
}

/** A supported Linear delegation confirms handoff; it does not prove that Cyrus started execution. */
export function cyrus(options: CyrusOptions): WorkerConnector {
  const parsed = z
    .object({ delegateId: identifier, mcp: z.object({ serverName, endpoint }) })
    .safeParse(options);
  const timeoutMs = options?.timeoutMs ?? 15_000;
  if (
    !parsed.success ||
    !options.linear ||
    (typeof options.linear.accessToken !== "string" &&
      typeof options.linear.accessToken !== "function") ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 120_000
  )
    fail("invalid_configuration");
  const { delegateId, mcp } = parsed.data;
  const providerFetch = options.linear.fetch ?? fetch;
  const accessToken = options.linear.accessToken;
  const consumerSignal = options.linear.signal;

  async function request<T>(
    queryName: string,
    query: string,
    variables: Record<string, string>,
  ): Promise<T> {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), timeoutMs);
    const signal = consumerSignal
      ? AbortSignal.any([consumerSignal, deadline.signal])
      : deadline.signal;
    const aborted = () =>
      new CyrusConnectorError(consumerSignal?.aborted ? "cancelled" : "timeout");
    let onAbort: (() => void) | undefined;
    try {
      if (signal.aborted) throw aborted();
      const cancellation = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(aborted());
        signal.addEventListener("abort", onAbort, { once: true });
      });
      const boundedFetch: typeof fetch = (input, init) => {
        signal.throwIfAborted();
        const upstream = init?.signal ?? (input instanceof Request ? input.signal : undefined);
        return providerFetch(input, {
          ...init,
          signal: upstream ? AbortSignal.any([signal, upstream]) : signal,
        });
      };
      return await Promise.race([
        callLinearGraphQL<T>({
          api: { fetch: boundedFetch },
          credentials: { accessToken },
          queryName,
          query,
          variables,
        }),
        cancellation,
      ]);
    } catch (error) {
      if (error instanceof CyrusConnectorError) throw error;
      if (signal.aborted) throw aborted();
      return fail("provider_unavailable");
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  async function readIssue(id: string, commentId: string) {
    const response = await request<{ issue: unknown }>(
      "CommissionWorkRecord",
      'query CommissionWorkRecord($id:String!,$commentId:ID!){issue(id:$id){id url description delegate{id} comments(first:2,filter:{or:[{id:{eq:$commentId}},{body:{contains:"<!-- eve-commission:"}}]}){nodes{id body} pageInfo{hasNextPage}}}}',
      { id, commentId },
    );
    const record = recordSchema.safeParse(response?.issue);
    if (!record.success) return fail("work_unavailable");
    return record.data;
  }

  return {
    id: "cyrus-linear-v1",
    async prepare({ commissionId, reference }) {
      if (
        !identifier.safeParse(commissionId).success ||
        reference?.kind !== "linear-issue" ||
        !identifier.safeParse(reference.id).success
      )
        fail("invalid_reference");
      const contractCommentId = randomUUID();
      const record = await readIssue(reference.id, contractCommentId);
      if (
        record.delegate ||
        (record.description ?? "").includes("<!-- eve-commission:") ||
        record.comments.nodes.length ||
        record.comments.pageInfo.hasNextPage
      )
        fail("handoff_conflict");
      return Object.freeze({
        version: "2",
        contractCommentId,
        commissionId,
        issueId: record.id,
        issueUrl: record.url,
        delegateId,
        mcpServerName: mcp.serverName,
        mcpEndpoint: mcp.endpoint,
      });
    },
    async handoff({ commissionId, spec, binding }) {
      const parsedBinding = bindingSchema.safeParse(binding);
      if (!parsedBinding.success || parsedBinding.data.commissionId !== commissionId)
        fail("invalid_binding");
      const target = parsedBinding.data;
      if (
        target.delegateId !== delegateId ||
        target.mcpServerName !== mcp.serverName ||
        target.mcpEndpoint !== mcp.endpoint
      )
        fail("configuration_changed");
      // Select the worker fields explicitly: a structurally wider host object cannot leak guidance/history.
      const workerSpec = z
        .object({
          brief: z.string().min(1).max(100_000),
          acceptance: z.array(z.string().min(1).max(100_000)).min(1).max(100),
        })
        .safeParse({
          brief: spec?.brief,
          acceptance: spec?.acceptance,
        });
      if (!workerSpec.success) fail("invalid_binding");
      const contract = [
        `<!-- eve-commission:${commissionId} -->`,
        "## Commissioning contract",
        `Commission ID: ${commissionId}`,
        `MCP server: ${target.mcpServerName}`,
        `Endpoint: ${target.mcpEndpoint}`,
        `Canonical work issue: ${target.issueUrl}`,
        "Read commission_read with this commissionId before starting work. Use commission_consult for bounded questions and commission_report for checkpoints, failures, immutable proposals, and delivery observations. Poll commission_read for answers and revisions. Only the commissioner records decisions.",
        "",
        workerSpec.data.brief,
        "",
        "Acceptance:",
        ...workerSpec.data.acceptance.map((value) => `- ${value}`),
        `<!-- /eve-commission:${commissionId} -->`,
      ].join("\n");
      // Check the complete rendered contract before any handoff read or external mutation.
      if (contract.length > maxContractCharacters) fail("contract_too_large");
      const canonical = (record: z.infer<typeof recordSchema>) =>
        record.id === target.issueId &&
        record.url === target.issueUrl &&
        !(record.description ?? "").includes("<!-- eve-commission:");
      const matchesContract = (record: z.infer<typeof recordSchema>) =>
        canonical(record) &&
        !record.comments.pageInfo.hasNextPage &&
        record.comments.nodes.length === 1 &&
        record.comments.nodes[0].id === target.contractCommentId &&
        record.comments.nodes[0].body === contract;
      let current = await readIssue(target.issueId, target.contractCommentId);
      if (
        !canonical(current) ||
        current.comments.pageInfo.hasNextPage ||
        (current.delegate && current.delegate.id !== target.delegateId)
      )
        fail("handoff_conflict");
      if (current.comments.nodes.length) {
        if (!matchesContract(current)) fail("handoff_conflict");
        if (current.delegate?.id === target.delegateId) return;
      } else {
        // Delegation without the exact durable contract cannot be adopted or silently repaired.
        if (current.delegate) fail("handoff_conflict");
        const created = await request<{ commentCreate?: { success?: boolean } }>(
          "CommissionContract",
          "mutation CommissionContract($commentId:String!,$issueId:String!,$body:String!){commentCreate(input:{id:$commentId,issueId:$issueId,body:$body}){success}}",
          { commentId: target.contractCommentId, issueId: target.issueId, body: contract },
        );
        if (created?.commentCreate?.success !== true) fail("handoff_unconfirmed");
        current = await readIssue(target.issueId, target.contractCommentId);
        if (!matchesContract(current) || current.delegate) fail("handoff_unconfirmed");
      }
      // Linear provides no delegation CAS. Enrollment requires a dedicated issue during this boundary.
      // Never rewrite the description or an existing comment: concurrent work criteria remain intact.
      const updated = await request<{ issueUpdate?: { success?: boolean } }>(
        "CommissionActivate",
        "mutation CommissionActivate($id:String!,$delegateId:String!){issueUpdate(id:$id,input:{delegateId:$delegateId}){success}}",
        { id: target.issueId, delegateId: target.delegateId },
      );
      if (updated?.issueUpdate?.success !== true) fail("handoff_unconfirmed");
      const confirmed = await readIssue(target.issueId, target.contractCommentId);
      if (!matchesContract(confirmed) || confirmed.delegate?.id !== target.delegateId)
        fail("handoff_unconfirmed");
    },
  };
}

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
