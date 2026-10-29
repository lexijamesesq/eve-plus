import { randomUUID } from "node:crypto";
import { callLinearGraphQL } from "eve/channels/linear";
import { z } from "zod";
import { CyrusConnectorError, failCyrus as fail } from "./cyrus-errors.js";
import type { WorkerConnector } from "./worker.js";

export type { CommissioningConfig, Delivery } from "./config.js";
export { CyrusConnectorError } from "./cyrus-errors.js";
export type { Commissioner, Conversation } from "./types.js";
export type { WorkerBinding, WorkerConnector, WorkReference } from "./worker.js";

const hasControlCharacters = (value: string) =>
  Array.from(value).some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
const serverName = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
// The worker reaches the endpoint over HTTPS, or over plain HTTP only on this host.
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
// The contract's first line, and how a contract is recognized on an issue. It's a visible heading because Linear
// shows HTML comments as text.
const CONTRACT_HEADING = "## Commissioning contract";
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
      `query CommissionWorkRecord($id:String!,$commentId:ID!){issue(id:$id){id url description delegate{id} comments(first:2,filter:{or:[{id:{eq:$commentId}},{body:{contains:"${CONTRACT_HEADING}"}}]}){nodes{id body} pageInfo{hasNextPage}}}}`,
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
        (record.description ?? "").includes(CONTRACT_HEADING) ||
        record.comments.nodes.length ||
        record.comments.pageInfo.hasNextPage
      )
        fail("handoff_conflict");
      return Object.freeze({
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
      const contract = [
        CONTRACT_HEADING,
        `Commission ID: ${commissionId}`,
        `MCP server: ${target.mcpServerName}`,
        `Endpoint: ${target.mcpEndpoint}`,
        `Canonical work issue: ${target.issueUrl}`,
        "Read commission_read with this commissionId before starting work. Use commission_consult for bounded questions and commission_report for checkpoints, failures and immutable proposals. Poll commission_read for answers and revisions. Only the commissioner records decisions.",
        "",
        spec.brief,
        "",
        "Acceptance:",
        ...spec.acceptance.map((value) => `- ${value}`),
      ].join("\n");
      // Check the complete rendered contract before any handoff read or external mutation.
      if (contract.length > maxContractCharacters) fail("contract_too_large");
      const canonical = (record: z.infer<typeof recordSchema>) =>
        record.id === target.issueId &&
        record.url === target.issueUrl &&
        !(record.description ?? "").includes(CONTRACT_HEADING);
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
