import { extractBearerToken, verifyJwtEcdsa } from "eve/channels/auth";
import { decodeJwt } from "jose";
import {
  defaultLifetimeSeconds,
  duration,
  invalidConfiguration,
  text,
} from "./signed-worker-credential.js";
import type { Caller } from "./types.js";

export type { SignedWorkerCredentialOptions } from "./signed-worker-credential.js";
export { createSignedWorkerCredential } from "./signed-worker-credential.js";

export interface SignedWorkerAuthenticatorOptions {
  issuer: string;
  subject: string;
  /** Exact worker endpoint audience. */
  audience: string;
  /** SPKI PEM public trust. Empty trust denies all requests; overlap keys during rotation. */
  publicKeys: readonly string[];
  /** Positive seconds. Default: 300. */
  maxLifetimeSeconds?: number;
  /** Nonnegative seconds; zero is valid. Default: 30. */
  clockToleranceSeconds?: number;
}

const defaultClockToleranceSeconds = 30;

/** Opt-in CommissioningConfig.authenticateWorker; never grants owner/decision authority. */
export function createSignedWorkerAuthenticator(options: SignedWorkerAuthenticatorOptions) {
  const {
    issuer,
    subject,
    audience,
    maxLifetimeSeconds = defaultLifetimeSeconds,
    clockToleranceSeconds = defaultClockToleranceSeconds,
  } = options;
  if (
    !text(issuer) ||
    !text(subject) ||
    !text(audience) ||
    !Array.isArray(options.publicKeys) ||
    !options.publicKeys.every((key) => typeof key === "string" && key.trim().length > 0) ||
    !duration(maxLifetimeSeconds) ||
    !duration(clockToleranceSeconds, true)
  )
    invalidConfiguration();
  const publicKeys = [...options.publicKeys];
  return async (request: Request): Promise<Caller | null> => {
    const token = extractBearerToken(request.headers.get("authorization"));
    if (!token) return null;
    for (const publicKey of publicKeys) {
      const result = await verifyJwtEcdsa(token, {
        algorithm: "ES256",
        publicKey,
        issuer,
        audiences: [audience],
        subjects: [subject],
        clockSkewSeconds: clockToleranceSeconds,
      });
      // Eve's subject matcher supports wildcard patterns. This policy requires literal identity.
      if (!result.ok || result.sessionAuth.subject !== subject) continue;
      // Only decode the SAME token after Eve verifies its signature, issuer, audience and expiry.
      const { iat, exp } = decodeJwt(token);
      if (
        typeof iat !== "number" ||
        !Number.isFinite(iat) ||
        typeof exp !== "number" ||
        !Number.isFinite(exp) ||
        exp <= iat ||
        exp - iat > maxLifetimeSeconds ||
        iat > Date.now() / 1000 + clockToleranceSeconds
      )
        return null;
      return { verified: true, principalId: subject };
    }
    return null;
  };
}
