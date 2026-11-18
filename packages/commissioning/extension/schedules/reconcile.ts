import { defineSchedule } from "eve/schedules";
import extension from "../extension.js";
import { runtime } from "../lib/runtime.js";

/** Retries pending handoffs and notices, and tells the commissioner when a worker goes quiet. */
export default defineSchedule({
  cron: extension.config.reconcileCron ?? "* * * * *",
  timezone: extension.config.reconcileTimezone,
  run: ({ to }) => runtime().drain(to),
});
