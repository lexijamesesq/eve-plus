import { createHash, timingSafeEqual } from "node:crypto";
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
export const identity: Pick<
  CommissioningConfig,
  "workerPrincipalId" | "authenticateWorker" | "resolveSessionPrincipal" | "resolveDeliveryAuth"
> = {
  workerPrincipalId: workerId,
  authenticateWorker(request) {
    const token = extractBearerToken(request.headers.get("authorization"));
    return token && timingSafeEqual(hash(token), hash(requiredEnv("EXAMPLE_WORKER_TOKEN")))
      ? { verified: true, principalId: workerId }
      : null;
  },
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
