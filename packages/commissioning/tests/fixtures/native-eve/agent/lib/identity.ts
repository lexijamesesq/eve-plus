import { appendFileSync, existsSync } from "node:fs";
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
  async authenticateWorker(request: Request) {
    const caller = await originalIdentity.authenticateWorker(request);
    if (process.env.FIXTURE_WORKER_AUTH_JOURNAL) {
      const body = await request
        .clone()
        .json()
        .catch(() => null);
      // Observe only synthetic claim timestamps and logical arguments, never bearer bytes.
      const token = request.headers.get("authorization")?.slice(7);
      let issuedAt: number | undefined;
      let expiresAt: number | undefined;
      try {
        const claims = JSON.parse(Buffer.from(token?.split(".")[1] ?? "", "base64url").toString());
        issuedAt = typeof claims.iat === "number" ? claims.iat : undefined;
        expiresAt = typeof claims.exp === "number" ? claims.exp : undefined;
      } catch {}
      appendFileSync(
        process.env.FIXTURE_WORKER_AUTH_JOURNAL,
        `${JSON.stringify({
          accepted: caller !== null,
          time: Date.now(),
          issuedAt,
          expiresAt,
          method: body?.method,
          tool: body?.params?.name,
          arguments: body?.params?.arguments,
        })}\n`,
      );
    }
    return caller;
  },
  captureSource(ctx: ToolContext) {
    return { originSessionId: ctx.session.id };
  },
  resolveDeliveryAuth(principalId: string) {
    return process.env.FIXTURE_DELIVERY_HOLD && existsSync(process.env.FIXTURE_DELIVERY_HOLD)
      ? null
      : originalIdentity.resolveDeliveryAuth(principalId);
  },
};
