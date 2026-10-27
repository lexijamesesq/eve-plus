import { defineChannel, POST } from "eve/channels";
import { routeAuth } from "eve/channels/auth";
import { ownerRouteAuth } from "../lib/identity.js";

export default defineChannel({
  routes: [
    POST("/example/message", async (request, { from }) => {
      const auth = await routeAuth(request, ownerRouteAuth);
      if (auth instanceof Response) return auth;
      const input: unknown = await request.json();
      if (
        !input ||
        typeof input !== "object" ||
        !("message" in input) ||
        typeof input.message !== "string"
      )
        return new Response("Expected a message", { status: 400 });
      const session = await from("example-owner").send(input.message, {
        auth,
        turnPolicy: "queue",
      });
      return Response.json({ sessionId: session.id });
    }),
  ],
});
