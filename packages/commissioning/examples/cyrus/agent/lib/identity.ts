import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createSignedWorkerAuthenticator } from "@eve-plus/commissioning/auth";
import type { CommissioningConfig } from "@eve-plus/commissioning/config";
import { extractBearerToken, httpBasic } from "eve/channels/auth";
import { requiredEnv } from "./env.js";

// Local demonstration identities. A production app supplies its own verified mapping.
export const ownerId = "example-commissioner";
export const workerId = "example:builder";
export const getLinearAccessToken = () => requiredEnv("EXAMPLE_LINEAR_TOKEN");
export const ownerAuth = {
  authenticator: "http-basic",
  principalId: ownerId,
  principalType: "user",
  attributes: {},
};
export const ownerRouteAuth = httpBasic({
  username: ownerId,
  password: requiredEnv("EXAMPLE_OWNER_PASSWORD"),
});
const hash = (value: string) => createHash("sha256").update(value).digest();
const workerAuthMode = process.env.EXAMPLE_WORKER_AUTH ?? "bearer";
if (workerAuthMode !== "bearer" && workerAuthMode !== "signed")
  throw new Error("Unknown example worker auth mode");
const authenticateWorker: CommissioningConfig["authenticateWorker"] =
  workerAuthMode === "signed"
    ? createSignedWorkerAuthenticator({
        issuer: requiredEnv("EXAMPLE_WORKER_ISSUER"),
        subject: workerId,
        audience: requiredEnv("EXAMPLE_MCP_ENDPOINT"),
        publicKeys: [readFileSync(requiredEnv("EXAMPLE_WORKER_PUBLIC_KEY_FILE"), "utf8")],
      })
    : (request) => {
        const token = extractBearerToken(request.headers.get("authorization"));
        return token && timingSafeEqual(hash(token), hash(requiredEnv("EXAMPLE_WORKER_TOKEN")))
          ? { verified: true, principalId: workerId }
          : null;
      };
export const identity: Pick<
  CommissioningConfig,
  "workerPrincipalId" | "authenticateWorker" | "resolveSessionPrincipal" | "resolveDeliveryAuth"
> = {
  workerPrincipalId: workerId,
  authenticateWorker,
  resolveSessionPrincipal(auth) {
    return auth?.authenticator === "http-basic" &&
      auth.principalId === ownerId &&
      auth.principalType === "user"
      ? { verified: true, principalId: ownerId }
      : null;
  },
  resolveDeliveryAuth(principalId) {
    return principalId === ownerId ? ownerAuth : null;
  },
};
