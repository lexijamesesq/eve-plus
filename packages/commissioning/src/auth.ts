import { extractBearerToken, verifyJwtEcdsa } from "eve/channels/auth";
import type { JWTPayload } from "jose";
import { decodeJwt, importSPKI, jwtVerify } from "jose";
import type { SignedWorkerAlgorithm } from "./signed-worker-credential.js";
import {
  defaultLifetimeSeconds,
  duration,
  invalidConfiguration,
  text,
} from "./signed-worker-credential.js";
import type { Caller } from "./types.js";

export type {
  SignedWorkerAlgorithm,
  SignedWorkerCredentialOptions,
} from "./signed-worker-credential.js";
export { createSignedWorkerCredential } from "./signed-worker-credential.js";

export interface SignedWorkerAuthenticatorOptions {
  /** Defaults to the native Eve ES256 verifier; EdDSA uses JOSE. */
  algorithm?: SignedWorkerAlgorithm;
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
    algorithm = "ES256",
    audience,
    maxLifetimeSeconds = defaultLifetimeSeconds,
    clockToleranceSeconds = defaultClockToleranceSeconds,
  } = options;
  if (
    (algorithm !== "ES256" && algorithm !== "EdDSA") ||
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
      let claims: JWTPayload;
      if (algorithm === "ES256") {
        const result = await verifyJwtEcdsa(token, {
          algorithm,
          publicKey,
          issuer,
          audiences: [audience],
          subjects: [subject],
          clockSkewSeconds: clockToleranceSeconds,
        });
        // Eve's subject matcher supports wildcards; configured identity remains literal.
        if (!result.ok || result.sessionAuth.subject !== subject) continue;
        claims = decodeJwt(token);
      } else {
        try {
          const key = await importSPKI(publicKey, algorithm);
          const result = await jwtVerify(token, key, {
            algorithms: [algorithm],
            issuer,
            subject,
            audience,
            requiredClaims: ["iat", "exp"],
            clockTolerance: clockToleranceSeconds,
          });
          claims = result.payload;
        } catch {
          continue;
        }
      }
      const { iat, exp } = claims;
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
