import { randomUUID } from "node:crypto";
import { callLinearGraphQL } from "eve/channels/linear";
import { z } from "zod";
import { CyrusConnectorError, failCyrus as fail } from "./cyrus-errors.js";
import { endpoint, hasControlCharacters, serverName } from "./cyrus-worker.js";
import type { WorkerConnector } from "./worker.js";

export { CyrusConnectorError } from "./cyrus-errors.js";
export type {
  CyrusHeadersHelperOptions,
  CyrusServers,
  CyrusWorkerArtifacts,
} from "./cyrus-worker.js";
export { createCyrusWorkerArtifacts, runCyrusHeadersHelper } from "./cyrus-worker.js";

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
const identifier = z
  .string()
  .min(1)
  .max(256)
  .regex(/^\S+$/)
  .refine((value) => !hasControlCharacters(value));
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
