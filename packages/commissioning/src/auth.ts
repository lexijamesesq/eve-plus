import { extractBearerToken, verifyJwtEcdsa } from "eve/channels/auth";
import { decodeJwt, importPKCS8, SignJWT } from "jose";
import type { Caller } from "./types.js";

export interface SignedWorkerCredentialOptions {
  issuer: string;
  subject: string;
  /** Resolve a dedicated ES256 PKCS8 key through the consumer's custody boundary. */
  resolvePrivateKey(input: { endpoint: string; signal: AbortSignal }): string | Promise<string>;
  /** Positive seconds, matched to the server's maximum lifetime. Default: 300. */
  lifetimeSeconds?: number;
}

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

const defaultLifetimeSeconds = 300;
const defaultClockToleranceSeconds = 30;
function text(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Array.from(value).every(
      (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
    )
  );
}
function duration(value: number, allowZero = false) {
  return Number.isFinite(value) && (allowZero ? value >= 0 : value > 0);
}
function invalidConfiguration(): never {
  throw new Error("Invalid signed worker authentication configuration");
}

/** Opt-in credential callback for a worker, including runCyrusHeadersHelper.resolveCredential. */
export function createSignedWorkerCredential(options: SignedWorkerCredentialOptions) {
  const { issuer, subject, resolvePrivateKey, lifetimeSeconds = defaultLifetimeSeconds } = options;
  if (
    !text(issuer) ||
    !text(subject) ||
    typeof resolvePrivateKey !== "function" ||
    !duration(lifetimeSeconds)
  )
    invalidConfiguration();
  return async ({
    endpoint,
    signal,
  }: {
    endpoint: string;
    signal: AbortSignal;
  }): Promise<string> => {
    try {
      if (!text(endpoint)) throw new Error();
      signal.throwIfAborted();
      const pem = await resolvePrivateKey({ endpoint, signal });
      signal.throwIfAborted();
      const key = await importPKCS8(pem, "ES256");
      const now = Math.floor(Date.now() / 1000);
      const credential = await new SignJWT({})
        .setProtectedHeader({ alg: "ES256" })
        .setIssuer(issuer)
        .setSubject(subject)
        .setAudience(endpoint)
        .setIssuedAt(now)
        .setExpirationTime(now + lifetimeSeconds)
        .sign(key);
      signal.throwIfAborted();
      return credential;
    } catch {
      throw new Error("Signed worker credential unavailable");
    }
  };
}

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
