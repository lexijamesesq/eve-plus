import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const tarballOption = args.indexOf("--tarball");
let suppliedTarball;
if (tarballOption >= 0) {
  assert.ok(args[tarballOption + 1], "--tarball requires an existing reviewed package path");
  suppliedTarball = resolve(args[tarballOption + 1]);
  args.splice(tarballOption, 2);
}
assert.ok(
  args.length <= 1 && !args[0]?.startsWith("--"),
  "Usage: public-consumer.mjs [stage] [--tarball path]",
);
const stage = args[0] ? resolve(args[0]) : await mkdtemp(join(tmpdir(), "commissioning-public-"));
await mkdir(stage, { recursive: true });
const consumer = join(stage, "consumer");
const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` };
function run(command, args, cwd, extra = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...env, ...extra },
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
assert.ok(Number(process.versions.node.split(".")[0]) >= 24, "Node 24 or newer is required");
let tarball = suppliedTarball;
if (!tarball) {
  run(join(packageRoot, "node_modules/.bin/eve"), ["extension", "build"], packageRoot);
  run(join(packageRoot, "node_modules/.bin/tsc"), ["-p", "tsconfig.build.json"], packageRoot);
  run("npm", ["pack", "--ignore-scripts", "--pack-destination", stage], packageRoot);
  tarball = join(
    stage,
    (await readdir(stage)).find((name) => name.endsWith(".tgz")) ?? "missing-tarball",
  );
}
const sha256 = createHash("sha256")
  .update(await readFile(tarball))
  .digest("hex");
await mkdir(consumer, { recursive: true });
// Bootstrap dependencies only; all application code below comes from the installed tarball.
const exampleManifest = JSON.parse(
  await readFile(join(packageRoot, "examples/cyrus/package.json"), "utf8"),
);
await writeFile(join(consumer, "package.json"), `${JSON.stringify(exampleManifest, null, 2)}\n`);
run("npm", ["install", "--no-audit", "--no-fund", tarball], consumer);
const installedRoot = join(consumer, "node_modules/@eve-plus/commissioning");
const manifest = JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8"));
const shippedExample = join(installedRoot, "examples/cyrus");
assert.deepEqual(
  JSON.parse(await readFile(join(shippedExample, "package.json"), "utf8")),
  exampleManifest,
  "Bootstrap manifest must match the actual distributed example",
);
await cp(shippedExample, consumer, {
  recursive: true,
  filter: (path) => path !== join(shippedExample, "package.json"),
});
const imports = [];
for (const subpath of Object.keys(manifest.exports)) {
  const name = subpath === "." ? manifest.name : `${manifest.name}/${subpath.slice(2)}`;
  imports.push(name);
}
run(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    `for (const name of ${JSON.stringify(imports)}) await import(name);`,
  ],
  consumer,
);
const { CommissionStore } = await import(
  pathToFileURL(join(installedRoot, manifest.exports["./store"].import)).href
);
const file = join(stage, "installed-sqlite", "ledger.sqlite");
let store = new CommissionStore(file);
const owner = { verified: true, principalId: "unrelated-application-owner" };
const worker = { verified: true, principalId: "unrelated-application-worker" };
store.open(
  owner,
  {
    commissionId: "installed-consumer",
    spec: {
      brief: "Test installed native driver",
      acceptance: ["Reopens"],
      privateGuidance: "PRIVATE_CONSUMER_GUIDANCE",
    },
  },
  worker,
);
store.close();
store = new CommissionStore(file);
assert.equal(
  store.read(owner, "installed-consumer").spec.privateGuidance,
  "PRIVATE_CONSUMER_GUIDANCE",
);
assert.equal(
  JSON.stringify(store.read(worker, "installed-consumer")).includes("PRIVATE_CONSUMER_GUIDANCE"),
  false,
);
store.close();
const modes = [];
for (const mode of ["neutral", "cyrus"]) {
  const config = {
    EXAMPLE_WORKER_MODE: mode,
    EXAMPLE_DATA_DIR: join(stage, "application-data"),
    EXAMPLE_OWNER_PASSWORD: "synthetic-owner-only",
    EXAMPLE_WORKER_TOKEN: "synthetic-worker-only",
    ...(mode === "cyrus"
      ? {
          EXAMPLE_LINEAR_TOKEN: "synthetic-linear-only",
          EXAMPLE_CYRUS_DELEGATE_ID: "synthetic-cyrus-delegate",
          EXAMPLE_MCP_ENDPOINT: "http://127.0.0.1:43229/commissioning/mcp",
        }
      : {}),
  };
  // Neutral mode deliberately has no Cyrus service configuration in its environment.
  for (const key of ["EXAMPLE_LINEAR_TOKEN", "EXAMPLE_CYRUS_DELEGATE_ID", "EXAMPLE_MCP_ENDPOINT"])
    if (mode === "neutral") config[key] = "";
  run("npm", ["run", "typecheck"], consumer, config);
  const build = run("npm", ["run", "build"], consumer, config);
  await writeFile(join(stage, `build-${mode}.log`), build);
  const discovery = JSON.parse(await readFile(join(consumer, ".eve/agent-summary.json"), "utf8"));
  for (const name of ["commissioning__open", "commissioning__read", "commissioning__decide"])
    assert.ok(
      discovery.tools.some((tool) => tool.name === name),
      `Missing native tool ${name}`,
    );
  assert.ok(
    discovery.schedules.some(
      (schedule) => schedule.name === "commissioning__reconcile" && schedule.cron === "* * * * *",
    ),
  );
  assert.deepEqual(
    discovery.channels
      .filter((channel) => channel.name === "commissioning__commissioning")
      .map((channel) => `${channel.method} ${channel.urlPath}`)
      .sort(),
    ["DELETE /commissioning/mcp", "GET /commissioning/mcp", "POST /commissioning/mcp"],
  );
  const serverManifest = JSON.parse(
    await readFile(join(consumer, ".output/server/package.json"), "utf8"),
  );
  assert.equal(serverManifest.dependencies["better-sqlite3"], "13.0.3");
  await writeFile(join(stage, `discovery-${mode}.json`), `${JSON.stringify(discovery, null, 2)}\n`);
  modes.push({
    mode,
    typecheck: true,
    build: true,
    discoveredDefaultToolsChannelSchedule: true,
    nativeDriverExternal: true,
  });
}
const extensionManifest = JSON.parse(
  await readFile(
    join(consumer, "node_modules/@eve-plus/commissioning/dist/extension/_manifest.json"),
    "utf8",
  ),
);
assert.ok(extensionManifest.build.externalDependencies.includes("better-sqlite3"));
const result = {
  passed: true,
  stage,
  consumer,
  tarball,
  sha256,
  sourceBuildPerformed: !suppliedTarball,
  node: process.version,
  eve: "0.83.2",
  imports,
  modes,
  installedSQLiteReopened: true,
  limits:
    "Build/import/type/native-driver qualification only. No agent runtime or live service/model request was launched.",
};
await writeFile(join(stage, "consumer-result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
