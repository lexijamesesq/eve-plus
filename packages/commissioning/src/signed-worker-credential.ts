import { importPKCS8, SignJWT } from "jose";

export interface SignedWorkerCredentialOptions {
  issuer: string;
  subject: string;
  /** Resolve a dedicated ES256 PKCS8 key through the consumer's custody boundary. */
  resolvePrivateKey(input: { endpoint: string; signal: AbortSignal }): string | Promise<string>;
  /** Positive seconds, matched to the server's maximum lifetime. Default: 300. */
  lifetimeSeconds?: number;
}

export const defaultLifetimeSeconds = 300;
export function text(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Array.from(value).every(
      (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
    )
  );
}
export function duration(value: number, allowZero = false) {
  return Number.isFinite(value) && (allowZero ? value >= 0 : value > 0);
}
export function invalidConfiguration(): never {
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
