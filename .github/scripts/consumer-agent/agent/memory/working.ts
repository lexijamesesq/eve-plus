import { workingMemory } from "@eve-plus/working";
import { defineMemory } from "eve/memory";

export default defineMemory({
  namespace: "consumer-working-v1",
  provider: workingMemory({
    dir: "/data/working",
    conversation: () => ({ kind: "named", name: "consumer" }),
  }),
  scope: () => "agent:consumer",
});
