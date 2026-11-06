import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-sonnet-5",
  build: {
    externalDependencies: ["@eve-plus/sandbox-microsandbox"],
  },
});
