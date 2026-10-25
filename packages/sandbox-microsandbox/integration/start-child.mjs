// One of two processes racing start() for the same session. Prints the sandbox name it got.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const pkg = join(process.cwd(), "node_modules/@eve-plus/sandbox-microsandbox/dist");
const { createImplementation } = await import(pathToFileURL(join(pkg, "provider.js")).href);
const artifact = JSON.parse(readFileSync("/home/node/artifact.json", "utf8"));
const ctx = {
  kind: "session",
  resolveProjectPath: (path) => path,
  session: { id: process.argv[2] },
  storagePath: "/home/node/storage",
};
const { state } = await createImplementation({}).start(ctx, undefined, artifact);
console.log(state.sandboxName);
