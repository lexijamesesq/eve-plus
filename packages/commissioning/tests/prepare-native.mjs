import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const stage = resolve(process.argv[2] ?? "");
assert.ok(process.argv[2], "Supply the stage emitted by test:consumer");
const result = JSON.parse(await readFile(join(stage, "consumer-result.json"), "utf8"));
assert.equal(result.passed, true);
const consumer = join(stage, "consumer");
const overlay = fileURLToPath(new URL("./fixtures/native-eve/agent", import.meta.url));
if (!existsSync(join(consumer, "agent/lib/example-identity.ts")))
  await rename(
    join(consumer, "agent/lib/identity.ts"),
    join(consumer, "agent/lib/example-identity.ts"),
  );
if (!existsSync(join(consumer, "agent/lib/example-linear.ts")))
  await rename(
    join(consumer, "agent/lib/linear.ts"),
    join(consumer, "agent/lib/example-linear.ts"),
  );
await cp(overlay, join(consumer, "agent"), { recursive: true });
const manifest = JSON.parse(await readFile(join(consumer, "package.json"), "utf8"));
manifest.dependencies["better-sqlite3"] = "13.0.3";
manifest.devDependencies["@types/better-sqlite3"] = "^9.6.0";
await writeFile(join(consumer, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
function run(command, args, cwd, env) {
  const child = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (child.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed\n${child.stdout}\n${child.stderr}`);
  return child.stdout.trim();
}
const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` };
run("npm", ["install", "--no-audit", "--no-fund"], consumer, env);
// Synthetic fixture only: no inherited Git routing, credentials, hooks, signing or author configuration.
const gitRoot = join(stage, "git");
const home = join(stage, "git-home");
const empty = join(stage, "git-empty");
for (const path of [gitRoot, home, empty]) await mkdir(path, { recursive: true });
const gitEnv = {
  PATH: env.PATH,
  HOME: home,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TEMPLATE_DIR: empty,
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Synthetic fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Synthetic fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};
const git = (...args) =>
  run(
    "git",
    ["-c", `core.hooksPath=${empty}`, "-c", "commit.gpgSign=false", ...args],
    gitRoot,
    gitEnv,
  );
if (!existsSync(join(stage, "fixture-commits.json"))) {
  git("init");
  const commits = [];
  for (const marker of ["not-ready", "ready"]) {
    await writeFile(join(gitRoot, "acceptance.txt"), `${marker}\n`);
    git("add", "acceptance.txt");
    git("commit", "-m", `Synthetic marker ${marker}`);
    commits.push(git("rev-parse", "HEAD"));
  }
  await writeFile(join(stage, "fixture-commits.json"), `${JSON.stringify(commits)}\n`);
}
const config = {
  EXAMPLE_WORKER_MODE: "cyrus",
  EXAMPLE_DATA_DIR: join(stage, "application-data"),
  EXAMPLE_OWNER_PASSWORD: "synthetic-owner-only",
  EXAMPLE_WORKER_TOKEN: "synthetic-worker-only",
  EXAMPLE_LINEAR_TOKEN: "synthetic-linear-only",
  EXAMPLE_CYRUS_DELEGATE_ID: "synthetic-cyrus-delegate",
  EXAMPLE_MCP_ENDPOINT: "http://127.0.0.1:43229/commissioning/mcp",
  EXAMPLE_ARTIFACT_REPOSITORY: "https://example.test/repo",
  EXAMPLE_GIT_DIR: gitRoot,
  FIXTURE_LINEAR_URL: "http://127.0.0.1:43230/graphql",
};
const cyrusKeys = [
  "EXAMPLE_LINEAR_TOKEN",
  "EXAMPLE_CYRUS_DELEGATE_ID",
  "EXAMPLE_MCP_ENDPOINT",
  "FIXTURE_LINEAR_URL",
];
const neutralConfig = { ...config, EXAMPLE_WORKER_MODE: "neutral" };
for (const key of cyrusKeys) delete neutralConfig[key];
for (const modeConfig of [neutralConfig, config]) {
  const buildEnv = { ...env, ...modeConfig };
  if (modeConfig.EXAMPLE_WORKER_MODE === "neutral")
    for (const key of cyrusKeys) delete buildEnv[key];
  run("npm", ["run", "typecheck"], consumer, buildEnv);
  const build = run("npm", ["run", "build"], consumer, buildEnv);
  await writeFile(
    join(stage, `build-native-overlay-${modeConfig.EXAMPLE_WORKER_MODE}.log`),
    `${build}\n`,
  );
  // Preserve each normal Eve build from the same consumer; do not depend on runtime configuration rebinding.
  const output = join(stage, "native-output", modeConfig.EXAMPLE_WORKER_MODE);
  await rm(output, { recursive: true, force: true });
  await cp(join(consumer, ".output"), output, { recursive: true, dereference: true });
}
await writeFile(
  join(stage, "native-config-neutral.json"),
  `${JSON.stringify(neutralConfig, null, 2)}\n`,
  { mode: 0o600 },
);
await writeFile(join(stage, "native-config.json"), `${JSON.stringify(config, null, 2)}\n`, {
  mode: 0o600,
});
const runtime = join(stage, "cyrus-runtime");
await mkdir(runtime, { recursive: true });
await cp(
  fileURLToPath(new URL("./cyrus-runtime/package.json", import.meta.url)),
  join(runtime, "package.json"),
);
if (process.argv.includes("--install-cyrus"))
  run("npm", ["install", "--no-audit", "--no-fund"], runtime, env);
await chmod(join(consumer, "scripts/headers-helper.mjs"), 0o700);
const receipt = {
  prepared: true,
  stage,
  tarballSha256: result.sha256,
  node: process.version,
  platform: process.platform,
  architecture: process.arch,
  controls:
    "Canonical example plus adversarial model/identity-availability/HTTP-boundary/fault overlays; default package contributions unchanged",
  runtimeStarted: false,
  cyrusDependenciesInstalled: existsSync(
    join(runtime, "node_modules/cyrus-claude-runner/package.json"),
  ),
  cyrusDependenciesInstalledThisRun: process.argv.includes("--install-cyrus"),
  preparedModes: ["neutral", "cyrus"],
  outputs: { neutral: "native-output/neutral", cyrus: "native-output/cyrus" },
};
await writeFile(join(stage, "native-preparation.json"), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt, null, 2));
