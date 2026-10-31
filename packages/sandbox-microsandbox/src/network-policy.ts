/**
 * The network policies this provider enforces, from strictest to loosest. `public` is microsandbox's own public
 * profile: public internet addresses and DNS through the host, with private, loopback, link-local, metadata and
 * host addresses denied.
 */
export type MicrosandboxNetworkPolicy = "deny-all" | "public" | "allow-all";

const POLICIES: readonly MicrosandboxNetworkPolicy[] = ["deny-all", "public", "allow-all"];

/** Whether a sandbox created under `existing` already gives no more than `requested` allows. */
export function isNoLooserThan(
  existing: MicrosandboxNetworkPolicy,
  requested: MicrosandboxNetworkPolicy,
): boolean {
  return POLICIES.indexOf(existing) <= POLICIES.indexOf(requested);
}

/**
 * Thrown for any network policy other than the two string literals. eve's rule is that a
 * provider rejects what it cannot enforce instead of weakening it: microsandbox cannot inject
 * the headers eve's `transform` rules add, and cannot change a live sandbox's policy.
 */
export class UnsupportedNetworkPolicyError extends Error {
  override readonly name = "UnsupportedNetworkPolicyError";

  constructor(policy: unknown) {
    super(
      `The microsandbox provider supports only the "deny-all", "public" and "allow-all" network policies, ` +
        `got ${describe(policy)}. Allowlists, transform, match, forwardURL and subnets are not supported.`,
    );
  }
}

/** Resolves the policy a sandbox starts with. Absent means `deny-all`, unlike eve's Docker provider. */
export function resolveNetworkPolicy(policy: unknown): MicrosandboxNetworkPolicy {
  if (policy === undefined) return "deny-all";
  if (policy === "deny-all" || policy === "public" || policy === "allow-all") return policy;
  throw new UnsupportedNetworkPolicyError(policy);
}

function describe(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
