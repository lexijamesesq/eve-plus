import commissioning from "@eve-plus/commissioning";
import { requiredEnv } from "../lib/env.js";
export const ownerAuth = {
  authenticator: "fixture-owner",
  principalId: "fixture:owner",
  principalType: "user",
  attributes: {},
};
export default commissioning({
  dataDir: requiredEnv("FIXTURE_DATA_DIR"),
  namespace: "native-proof",
  workerPrincipalId: "fixture:worker",
  authenticateWorker: (request) =>
    request.headers.get("authorization") === "Bearer fixture-worker-only"
      ? { verified: true, principalId: "fixture:worker" }
      : null,
  resolveSessionPrincipal: (auth) =>
    auth?.authenticator === "fixture-owner" && auth.principalId === "fixture:owner"
      ? { verified: true, principalId: "fixture:owner" }
      : null,
  resolveDeliveryAuth: (id) => (id === "fixture:owner" ? ownerAuth : null),
  overdueAfterMs: 3600000,
});
