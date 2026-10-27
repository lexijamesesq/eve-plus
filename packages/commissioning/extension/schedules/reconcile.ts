import { defineSchedule } from "eve/schedules";
import commissioning from "../channels/commissioning.js";
import extension from "../extension.js";
import { runtime } from "../lib/runtime.js";
export default defineSchedule({
  cron: extension.config.reconcileCron ?? "* * * * *",
  async run({ to }) {
    await runtime().drain((delivery) =>
      to(commissioning, {
        commissionId: delivery.entry.commissionId,
        eventId: delivery.entry.eventId,
      }).send(delivery.message, { auth: delivery.auth }),
    );
  },
});
