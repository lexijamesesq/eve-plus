// Runs with an older msb placed where microsandbox might pick it up (MSB_PATH, or MSB_HOME's
// bin/ and lib/, where a runtime linked or installed by hand lives). Prints which runtime
// resolved, then whether the provider accepts it.
import { readFileSync } from "node:fs";
import { resolveRuntime, resolveRuntimeVersion } from "microsandbox";

const pkg = "./node_modules/@eve-plus/sandbox-microsandbox/dist";
const { createImplementation } = await import(`${pkg}/provider.js`);
const runtime = resolveRuntime();
console.log(`resolved ${runtime.origin} ${await resolveRuntimeVersion(runtime.msbPath)}`);
const artifact = JSON.parse(readFileSync("/home/node/artifact.json", "utf8"));
const ctx = {
  kind: "session",
  resolveProjectPath: (path) => path,
  session: { id: "stale" },
  storagePath: "/home/node/storage",
};
try {
  await createImplementation({}).start(ctx, undefined, artifact);
  console.log("accepted");
} catch (error) {
  console.log(`refused ${error.name}: ${error.message}`);
}
