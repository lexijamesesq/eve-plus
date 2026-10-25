// A new process that resumes the session the proof recorded. Prints the kept file's contents.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const pkg = join(process.cwd(), "node_modules/@eve-plus/sandbox-microsandbox/dist");
const { createImplementation } = await import(pathToFileURL(join(pkg, "provider.js")).href);
const artifact = JSON.parse(readFileSync("/home/node/artifact.json", "utf8"));
const state = JSON.parse(readFileSync("/home/node/proof-state.json", "utf8"));
const ctx = {
  kind: "session",
  resolveProjectPath: (path) => path,
  session: { id: "bare-open" },
  storagePath: "/home/node/storage",
};
const connection = await createImplementation({}).resume(ctx, artifact, state);
const bytes = await connection.readFile({ path: "/workspace/kept.txt" });
await connection.stop();
console.log(bytes === null ? "null" : new TextDecoder().decode(bytes));
