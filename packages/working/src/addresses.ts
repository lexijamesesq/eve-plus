// The conversations a loop belongs to. The package owns the union; the host resolves a turn's address from its
// session auth (`WorkingMemoryOptions.conversation`), since only the host knows its channels.

import { z } from "zod";

/** Where a loop belongs: one conversation, as the host names it. */
export type Address =
  | {
      readonly kind: "slack-thread";
      readonly teamId: string;
      readonly channelId: string;
      readonly threadTs: string;
    }
  /** A DM is one conversation: eve starts a session per top-level DM, and each must see the others' loops. */
  | { readonly kind: "slack-dm"; readonly teamId: string; readonly channelId: string }
  | {
      readonly kind: "linear-session";
      readonly organizationId: string;
      readonly agentSessionId: string;
      readonly issueId: string;
    }
  | {
      readonly kind: "github";
      readonly repository: string;
      readonly number: number;
      readonly conversationKind: "pull_request" | "issue";
    }
  | { readonly kind: "named"; readonly name: string };

const part = z.string().min(1).max(256);
/** Checks what a host resolver returns before it becomes a store key. */
export const addressSchema: z.ZodType<Address> = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("slack-thread"), teamId: part, channelId: part, threadTs: part })
    .strict(),
  z.object({ kind: z.literal("slack-dm"), teamId: part, channelId: part }).strict(),
  z
    .object({
      kind: z.literal("linear-session"),
      organizationId: part,
      agentSessionId: part,
      issueId: part,
    })
    .strict(),
  z
    .object({
      kind: z.literal("github"),
      repository: part,
      number: z.number().int().nonnegative(),
      conversationKind: z.enum(["pull_request", "issue"]),
    })
    .strict(),
  z.object({ kind: z.literal("named"), name: part }).strict(),
]);

/** The store's conversation key: deterministic, one per conversation, independent of property order. */
export function addressKey(address: Address): string {
  switch (address.kind) {
    case "slack-thread":
      return `slack-thread:${address.teamId}/${address.channelId}/${address.threadTs}`;
    case "slack-dm":
      return `slack-dm:${address.teamId}/${address.channelId}`;
    case "linear-session":
      return `linear-session:${address.organizationId}/${address.agentSessionId}/${address.issueId}`;
    case "github":
      return `github:${address.repository}/${address.conversationKind}/${address.number}`;
    case "named":
      return `named:${address.name}`;
  }
}
