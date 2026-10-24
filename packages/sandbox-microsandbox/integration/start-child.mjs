// One of two processes racing start() for the same session. Prints the sandbox name it got.
import { readFileSync } from "node:fs";

const { createImplementation } = await import(
  "./node_modules/@eve-plus/sandbox-microsandbox/dist/provider.js"
);
const artifact = JSON.parse(readFileSync("/home/node/artifact.json", "utf8"));
const ctx = {
  kind: "session",
  resolveProjectPath: (path) => path,
  session: { id: process.argv[2] },
  storagePath: "/home/node/storage",
};
const { state } = await createImplementation({}).start(ctx, undefined, artifact);
console.log(state.sandboxName);
