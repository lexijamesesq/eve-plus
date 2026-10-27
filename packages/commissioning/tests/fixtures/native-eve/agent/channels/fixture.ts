import { defineChannel, POST } from "eve/channels";
import { ownerAuth } from "../extensions/commissioning.js";
// Isolated fixture route only. Never mount this helper in an estate agent.
export default defineChannel({
  routes: [
    POST("/fixture/open", async (_request, { from }) =>
      Response.json({
        sessionId: (
          await from("original-owner").send("OPEN ORIGINAL_CONTEXT_SENTINEL", {
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
