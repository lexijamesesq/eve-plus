import { existsSync } from "node:fs";
import type { ToolContext } from "eve/tools";
import { identity as originalIdentity } from "./example-identity.js";

export {
  getLinearAccessToken,
  ownerAuth,
  ownerId,
  ownerRouteAuth,
  workerId,
} from "./example-identity.js";
// Test overlay adds trusted origin provenance and delivery availability; identities remain the example's adapter.
export const identity = {
  ...originalIdentity,
  captureSource(ctx: ToolContext) {
    return { originSessionId: ctx.session.id };
  },
  resolveDeliveryAuth(principalId: string) {
    return process.env.FIXTURE_DELIVERY_HOLD && existsSync(process.env.FIXTURE_DELIVERY_HOLD)
      ? null
      : originalIdentity.resolveDeliveryAuth(principalId);
  },
};
