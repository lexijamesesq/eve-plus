import { z } from "zod";

// Every input is validated here, once, before it reaches the store: tool and MCP arguments, and what the
// consumer's `commissioner` callback returns.
const id = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      Array.from(value).every((character) => character.charCodeAt(0) > 31 && character !== "\x7f"),
    "Identifiers can't contain control characters",
  );
const text = z.string().trim().min(1).max(32768);

export const conversationSchema = z
  .record(z.string().min(1).max(64), z.string().min(1).max(1024))
  .refine((value) => {
    const size = Object.keys(value).length;
    return size >= 1 && size <= 16;
  }, "A conversation has 1 to 16 fields");
export const commissionerSchema = z.object({ id, conversation: conversationSchema }).strict();
export const workReferenceSchema = z.object({ kind: id, id }).strict();
export const specSchema = z
  .object({ brief: text, acceptance: z.array(text).min(1).max(100) })
  .strict();

const httpsUrl = z.url({ protocol: /^https$/ }).refine((value) => {
  const url = new URL(value);
  return !url.username && !url.password && !url.search && !url.hash;
}, "Use a credential-free HTTPS URL without a query or fragment");
// A pull request URL must name a PR of the artifact's own repository, on GitHub or GitLab.
const artifactSchema = z
  .object({
    repository: httpsUrl,
    commit: z.string().regex(/^[a-f0-9]{40}$/, "Use the full lowercase 40-hex commit"),
    pullRequest: httpsUrl,
  })
  .strict()
  .refine(({ repository, pullRequest }) => {
    const repo = new URL(repository);
    const pr = new URL(pullRequest);
    const path = repo.pathname.replace(/\.git$/, "").replace(/\/$/, "");
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return (
      path.length > 1 &&
      repo.origin === pr.origin &&
      new RegExp(`^${escaped}/(?:pull|merge_requests|-/merge_requests)/[1-9][0-9]*/?$`).test(
        pr.pathname,
      )
    );
  }, "The pull request must belong to the artifact's repository");

export const openSchema = z
  .object({ spec: specSchema, workReference: workReferenceSchema })
  .strict();
export const ownerReadSchema = z.object({ commissionId: id }).strict();
export const readSchema = z
  .object({ commissionId: id, after: z.number().int().nonnegative().default(0) })
  .strict();
export const consultSchema = z
  .object({
    commissionId: id,
    questionId: id,
    question: z.object({ text, options: z.array(text).max(20).optional() }).strict(),
  })
  .strict();
const base = { commissionId: id, eventId: id };
export const reportSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...base,
      kind: z.literal("proposal"),
      data: z.object({ summary: text, artifact: artifactSchema }).strict(),
    })
    .strict(),
  z
    .object({ ...base, kind: z.literal("checkpoint"), data: z.object({ summary: text }).strict() })
    .strict(),
  z
    .object({ ...base, kind: z.literal("failure"), data: z.object({ summary: text }).strict() })
    .strict(),
]);
// What the worker endpoint publishes for commission_report: one flat object, because an MCP client is shown no
// arguments for a discriminated union. reportSchema then applies the per-kind rules inside the handler.
export const reportToolSchema = z
  .object({
    commissionId: id,
    eventId: id,
    kind: z.enum(["checkpoint", "failure", "proposal"]),
    data: z
      .object({
        summary: text,
        artifact: z
          .object({ repository: z.string(), commit: z.string(), pullRequest: z.string() })
          .strict()
          .optional()
          .describe(
            "Required for a proposal, and only for one: HTTPS repository, full 40-hex commit, and its PR",
          ),
      })
      .strict(),
  })
  .strict();
export const decideSchema = z.discriminatedUnion("target", [
  z
    .object({
      ...base,
      target: z.literal("question"),
      questionId: id,
      decision: z.object({ answer: text }).strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      target: z.literal("proposal"),
      proposalId: id,
      decision: z.object({ verdict: z.enum(["accept", "revise"]), feedback: text }).strict(),
    })
    .strict(),
]);
