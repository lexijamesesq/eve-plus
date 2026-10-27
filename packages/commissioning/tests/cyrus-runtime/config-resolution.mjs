import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inspectCyrusRuntime } from "../cyrus-runtime-proof.mjs";

assert.ok(process.argv[2], "Supply the prepared public-consumer stage");
const stage = resolve(process.argv[2]);
const consumer = join(stage, "consumer");
const requireRuntime = createRequire(join(stage, "cyrus-runtime/package.json"));
const metadata = requireRuntime("cyrus-edge-worker/package.json");
assert.equal(metadata.version, "0.2.73");
// Only the released package root: no implementation-file imports or private methods.
const { RunnerConfigBuilder, ToolPermissionResolver, McpConfigService } = await import(
  pathToFileURL(requireRuntime.resolve("cyrus-edge-worker")).href
);
assert.equal(typeof RunnerConfigBuilder, "function");
assert.equal(typeof ToolPermissionResolver, "function");
assert.equal(typeof McpConfigService, "function");
const versions = { ...(await inspectCyrusRuntime(stage)), edgeWorker: metadata.version };
const config = JSON.parse(await readFile(join(stage, "native-config.json"), "utf8"));
// Run the installed example's pure artifact generator; no helper, daemon, runner, or model starts.
const generated = spawnSync(process.execPath, [join(consumer, "scripts/worker-artifacts.mjs")], {
  cwd: consumer,
  env: {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    EXAMPLE_MCP_ENDPOINT: config.EXAMPLE_MCP_ENDPOINT,
    EXAMPLE_WORKER_CREDENTIAL_FILE: join(stage, "unused-synthetic-credential"),
  },
  encoding: "utf8",
});
assert.equal(generated.status, 0, "Installed canonical artifact generator failed");
const tools = JSON.parse(await readFile(join(consumer, "worker-allowed-tools.json"), "utf8"));
const protocol = await readFile(join(consumer, "worker-instructions.md"), "utf8");
assert.deepEqual(
  tools.slice().sort(),
  ["commission_consult", "commission_read", "commission_report"].map(
    (name) => `mcp__commissioner__${name}`,
  ),
);
const generatedPath = join(consumer, "mcp.json");
const otherPath = join(stage, "existing-reviewed-mcp.json");
const repoPaths = [otherPath, generatedPath];
const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  event() {},
  withContext() {
    return this;
  },
};
const inherited = {
  linearAllowedTools: ["Read"],
  githubAllowedTools: ["Glob"],
  defaultDisallowedTools: ["Bash"],
};
const repository = {
  id: "synthetic-repository",
  name: "synthetic",
  path: join(stage, "unstarted-work"),
  mcpConfigPath: repoPaths,
  allowedTools: ["Read", ...tools],
  appendInstruction: `Existing repository restrictions remain applicable.\n\n${protocol}`,
};
const snapshot = JSON.stringify({ inherited, repository });
const permissions = new ToolPermissionResolver(inherited, logger);
const mcp = new McpConfigService({});
const builder = new RunnerConfigBuilder(
  permissions,
  {
    buildMcpConfig() {
      return {};
    }, // Pure assembly only; no service credentials or MCP server creation.
    buildMergedMcpConfigPath(repositories) {
      return mcp.buildMergedMcpConfigPath(repositories);
    },
  },
  {
    determineRunnerSelection() {
      return { runnerType: "claude" };
    },
    getDefaultRunner() {
      return "claude";
    },
    getDefaultModelForRunner() {
      return undefined;
    },
    getDefaultFallbackModelForRunner() {
      return undefined;
    },
  },
);
const assemble = (repo, allowedTools, platformMcpConfigOverrides) =>
  builder.buildIssueConfig({
    session: { issueId: "synthetic-issue", workspace: { path: repo.path } },
    repository: repo,
    sessionId: "synthetic-session",
    cyrusHome: join(stage, "unstarted-cyrus-home"),
    // Daemon prompt assembly is upstream of this public builder. This value is inline text.
    systemPrompt: repo.appendInstruction,
    allowedTools,
    disallowedTools: permissions.buildDisallowedTools(repo),
    allowedDirectories: [repo.path],
    platformMcpConfigOverrides,
    requireLinearWorkspaceId() {
      return "synthetic-workspace";
    },
    logger,
    onMessage() {},
    onError() {},
  }).config;

const explicitTools = permissions.buildAllowedTools(repository);
assert.deepEqual(explicitTools, ["Read", ...tools]);
const explicit = assemble(repository, explicitTools, [join(stage, "ignored-platform.json")]);
assert.deepEqual(explicit.mcpConfigPath, repoPaths);
assert.deepEqual(
  explicit.allowedTools.filter((name) => name.startsWith("mcp__")),
  tools,
);
assert.deepEqual(explicit.disallowedTools, ["Bash"]);
assert.ok(explicit.appendSystemPrompt.includes(protocol));
assert.ok(
  explicit.appendSystemPrompt.includes("Existing repository restrictions remain applicable."),
);

const { allowedTools: _explicitPolicy, ...inheritingRepo } = repository;
for (const platform of ["linear", "github"]) {
  const platformPaths = [join(stage, `${platform}-existing.json`), generatedPath];
  const policy =
    platform === "linear"
      ? permissions.buildAllowedTools(inheritingRepo)
      : permissions.buildGithubAllowedTools(inheritingRepo);
  assert.deepEqual(policy, inherited[`${platform}AllowedTools`]);
  const result = assemble(inheritingRepo, policy, platformPaths);
  assert.deepEqual(result.mcpConfigPath, platformPaths);
  assert.equal(
    result.allowedTools.some((name) => tools.includes(name)),
    false,
    "MCP registration cannot silently broaden inherited policy",
  );
  assert.equal(Object.hasOwn(inheritingRepo, "allowedTools"), false);
  const explicitPlatform = {
    ...inherited,
    [`${platform}AllowedTools`]: [...inherited[`${platform}AllowedTools`], ...tools],
  };
  const platformSnapshot = JSON.stringify(explicitPlatform);
  const platformPermissions = new ToolPermissionResolver(explicitPlatform, logger);
  const selected =
    platform === "linear"
      ? platformPermissions.buildAllowedTools(inheritingRepo)
      : platformPermissions.buildGithubAllowedTools(inheritingRepo);
  const enabled = assemble(inheritingRepo, selected, platformPaths);
  assert.deepEqual(enabled.mcpConfigPath, platformPaths);
  assert.deepEqual(
    enabled.allowedTools.filter((name) => name.startsWith("mcp__")),
    tools,
  );
  assert.ok(enabled.allowedTools.includes(platform === "linear" ? "Read" : "Glob"));
  assert.equal(JSON.stringify(explicitPlatform), platformSnapshot);
}
assert.equal(
  assemble(inheritingRepo, permissions.buildAllowedTools(inheritingRepo), undefined).mcpConfigPath,
  undefined,
);

const promptDefaults = { ...inherited, promptDefaults: { builder: { allowedTools: ["Edit"] } } };
const promptPermissions = new ToolPermissionResolver(promptDefaults, logger);
assert.deepEqual(promptPermissions.buildAllowedTools(repository, "builder"), ["Edit"]);
const labeled = { ...repository, labelPrompts: { builder: { allowedTools: ["Glob", ...tools] } } };
assert.deepEqual(promptPermissions.buildAllowedTools(labeled, "builder"), ["Glob", ...tools]);
assert.deepEqual(
  assemble(labeled, promptPermissions.buildAllowedTools(labeled, "builder"), []).allowedTools,
  ["Glob", ...tools],
);
const nativeDefaults = {};
const nativePermissions = new ToolPermissionResolver(nativeDefaults, logger);
assert.equal(
  nativePermissions.buildAllowedTools(inheritingRepo).some((name) => tools.includes(name)),
  false,
);
assert.deepEqual(nativeDefaults, {});
assert.equal(
  JSON.stringify({ inherited, repository }),
  snapshot,
  "Configuration inputs must remain unchanged",
);
const receipt = {
  passed: true,
  versions,
  executionPending: true,
  agentRuntimeStarted: false,
  publicExportsOnly: true,
  exactThreeMcpPermissions: true,
  repositoryAndPlatformMcpResolution: true,
  policyPrecedenceAndNoImplicitMerge: true,
  inheritedConfigurationUnchanged: true,
  inlineGeneratedProtocolPreserved: true,
  limits:
    "Pure public builder/resolver assembly. Full daemon prompt assembly, service startup and native SDK execution remain separate pending qualifications; appendInstruction is inline content passed as the builder's already assembled systemPrompt.",
};
await writeFile(
  join(stage, "cyrus-config-resolution.json"),
  `${JSON.stringify(receipt, null, 2)}\n`,
);
console.log(JSON.stringify(receipt, null, 2));
