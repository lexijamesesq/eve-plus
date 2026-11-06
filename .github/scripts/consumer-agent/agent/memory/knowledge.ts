import { shaclMemory } from "@eve-plus/memory";
import { defineMemory } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";

export default defineMemory({
  namespace: "consumer-knowledge-v1",
  provider: shaclMemory({ dir: "/data/memory" }),
  scope: byPrincipal,
});
