import commissioning from "@eve-plus/commissioning";
import { cyrus } from "@eve-plus/commissioning/cyrus";
import eve from "../channels/eve";

export default commissioning({
  dataDir: "/data/commissioning",
  namespace: "consumer",
  worker: cyrus({
    linear: { accessToken: () => "unused" },
    delegateId: "consumer-delegate",
    mcp: { serverName: "eve_consumer", endpoint: "https://consumer.example/commissioning/mcp" },
  }),
  authenticateWorker: () => false,
  commissioner: () => null,
  deliver: (conversation) => ({ channel: eve, target: { ...conversation }, auth: null as never }),
});
