import { z } from "zod";

const id = z.string().min(1).max(256);
const text = z.string().min(1).max(32768);
export const workReferenceSchema = z.object({ kind: id, id }).strict();
export const readSchema = z
  .object({ commissionId: id, after: z.number().int().nonnegative().default(0) })
  .strict();
export const openSchema = z
  .object({
    workReference: workReferenceSchema.optional(),
    spec: z
      .object({
        brief: text,
        acceptance: z.array(text).min(1).max(100),
        privateGuidance: text.optional(),
      })
      .strict(),
  })
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
      data: z
        .object({
          summary: text,
          artifact: z
            .object({
              repository: id,
              commit: z.string().regex(/^[a-f0-9]{40}$/),
              pullRequest: z.url(),
            })
            .strict(),
        })
        .strict(),
    })
    .strict(),
  ...["checkpoint", "failure"].map((kind) =>
    z
      .object({ ...base, kind: z.literal(kind), data: z.object({ summary: text }).strict() })
      .strict(),
  ),
  ...["reviewed", "merged", "deployed"].map((kind) =>
    z
      .object({
        ...base,
        kind: z.literal(kind),
        data: z.object({ summary: text, proposalId: id }).strict(),
      })
      .strict(),
  ),
]);
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
