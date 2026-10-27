import commissioning from "@eve-plus/commissioning";
import { requiredEnv } from "../lib/env.js";
import { identity } from "../lib/identity.js";
import { linear } from "../lib/linear.js";

const mode = process.env.EXAMPLE_WORKER_MODE ?? "cyrus";
if (mode !== "neutral" && mode !== "cyrus") throw new Error("Unknown example worker mode");
// Neutral mode never imports/configures Cyrus or asks for Linear credentials.
const worker =
  mode === "neutral"
    ? undefined
    : (await import("@eve-plus/commissioning/cyrus")).cyrus({
        linear,
        delegateId: requiredEnv("EXAMPLE_CYRUS_DELEGATE_ID"),
        mcp: { serverName: "commissioner", endpoint: requiredEnv("EXAMPLE_MCP_ENDPOINT") },
      });
export default commissioning({
  ...identity,
  dataDir: requiredEnv("EXAMPLE_DATA_DIR"),
  namespace: "example-commissions",
  ...(worker ? { worker } : {}),
});
