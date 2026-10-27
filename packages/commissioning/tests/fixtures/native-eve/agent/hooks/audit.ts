import { appendFileSync } from "node:fs";
import { defineHook } from "eve/hooks";
export default defineHook({
  events: {
    "turn.started"(_event, ctx) {
      if (process.env.FIXTURE_AUDIT)
        appendFileSync(
          process.env.FIXTURE_AUDIT,
          `${JSON.stringify({ stage: "native-turn", sessionId: ctx.session.id, channel: ctx.channel, principalId: ctx.session.auth.current?.principalId })}\n`,
        );
    },
  },
});
