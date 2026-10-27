import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CommissionStore } from "@eve-plus/commissioning/store";
import { defineChannel, POST } from "eve/channels";
import { routeAuth } from "eve/channels/auth";
import { requiredEnv } from "../lib/env.js";
import { ownerAuth, ownerId, ownerRouteAuth } from "../lib/identity.js";
// Isolated fixture route only. Never mount this helper in an estate agent.
export default defineChannel({
  routes: [
    // Isolated authorized-host recovery only. The request cannot select a foreign replacement.
    POST("/fixture/rebind", async (request) => {
      const auth = await routeAuth(request, ownerRouteAuth);
      if (auth instanceof Response) return auth;
      if (auth.principalId !== ownerId) return new Response("Forbidden", { status: 403 });
      const input = await request.json();
      const store = new CommissionStore(
        join(requiredEnv("EXAMPLE_DATA_DIR"), "example-commissions/commissions.sqlite"),
      );
      try {
        const caller = { verified: true as const, principalId: auth.principalId };
        store.read(caller, input.commissionId);
        const context = store.context(input.commissionId);
        if (
          !context?.source ||
          context.source.originSessionId !== context.originSessionId ||
          JSON.stringify(input.source) !== JSON.stringify(context.source)
        )
          return new Response("Source mismatch", { status: 403 });
        const records = (await readFile(requiredEnv("FIXTURE_AUDIT"), "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const canonical = records.filter(
          (entry) =>
            entry.stage === "native-turn" &&
            entry.channel?.continuationToken ===
              `commissioning__commissioning:${input.commissionId}` &&
            entry.principalId === ownerId,
        );
        const replacement = canonical.at(-1);
        const original = canonical[0];
        if (
          !replacement ||
          !original ||
          replacement.sessionId === original.sessionId ||
          replacement.channel.kind !== original.channel.kind ||
          replacement.sessionId !== input.replacementSessionId
        )
          return new Response("Replacement mismatch", { status: 403 });
        const result = store.rebindSession(
          caller,
          {
            commissionId: input.commissionId,
            eventId: "fixture-canonical-recovery",
            expectedActiveSessionId: input.expectedActiveSessionId,
            activeSessionId: replacement.sessionId,
            source: context.source,
          },
          caller,
        );
        return Response.json(result);
      } finally {
        store.close();
      }
    }),
    POST("/fixture/open", async (_request, { from }) =>
      Response.json({
        sessionId: (
          await from("original-owner").send("OPEN ENG-123 ORIGINAL_CONTEXT_SENTINEL", {
            auth: ownerAuth,
            idempotencyKey: "fixture-open",
          })
        ).id,
      }),
    ),
    POST("/fixture/bound", async (request, { from }) => {
      const { commissionId, questionId } = await request.json();
      return Response.json({
        sessionId: (
          await from("original-owner").send(
            `BOUND:${JSON.stringify({ commissionId, questionId })}`,
            {
              auth: ownerAuth,
              idempotencyKey: "fixture-bound-answer",
            },
          )
        ).id,
      });
    }),
    POST("/fixture/read", async (request, { from }) => {
      const { commissionId } = await request.json();
      return Response.json({
        sessionId: (
          await from("original-owner").send(`READ:${JSON.stringify({ commissionId })}`, {
            auth: ownerAuth,
            idempotencyKey: "fixture-owner-read",
          })
        ).id,
      });
    }),
    POST("/fixture/unbound", async (request, { from }) => {
      const { commissionId, questionId } = await request.json();
      return Response.json({
        sessionId: (
          await from("unbound-owner").send(
            `UNBOUND:${JSON.stringify({ commissionId, questionId })}`,
            {
              auth: ownerAuth,
              idempotencyKey: "fixture-unbound",
            },
          )
        ).id,
      });
    }),
  ],
});
