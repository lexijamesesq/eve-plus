import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
// Portable release consumption uses the same independent-consumer runner, without installing packages.
const workerOption = args.indexOf("--worker-archive");
if (workerOption >= 0) {
  assert.ok(args[workerOption + 1], "--worker-archive requires a reviewed archive");
  const archive = resolve(args[workerOption + 1]);
  args.splice(workerOption, 2);
  assert.ok(args.length <= 1, "Supply at most one clean worker stage");
  const workerStage = args[0]
    ? resolve(args[0])
    : await mkdtemp(join(tmpdir(), "commissioning-worker-consumer-"));
  await mkdir(workerStage, { recursive: true });
  const unpack = spawnSync("tar", ["-xzf", archive, "-C", workerStage], { encoding: "utf8" });
  assert.equal(unpack.status, 0, unpack.stderr);
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const root=process.argv[1];
const worker=await import(pathToFileURL(join(root,"index.js")).href);
assert.deepEqual(Object.keys(worker).sort(),["createCyrusWorkerArtifacts","createSignedWorkerCredential","runCyrusHeadersHelper"].sort());
const manifest=JSON.parse(await readFile(join(root,"package.json"),"utf8"));
assert.equal(manifest.name,"@eve-plus/commissioning-worker");
assert.equal(manifest.type,"module");
assert.match(manifest.gitHead,/^[0-9a-f]{40}$/);
assert.ok(!(await readdir(root)).includes("node_modules"));
assert.ok((await readFile(join(root,"LICENSE"),"utf8")).includes("MIT"));
const notices=await readFile(join(root,"licenses.txt"),"utf8");
assert.ok(notices.includes("jose") && notices.includes("zod"));
const endpoint="http://127.0.0.1:43229/commissioning/mcp";
const artifacts=worker.createCyrusWorkerArtifacts({servers:{commissioner:endpoint},headersHelperPath:"/synthetic/headers-helper"});
assert.deepEqual(artifacts.allowedTools,["mcp__commissioner__commission_read","mcp__commissioner__commission_consult","mcp__commissioner__commission_report"]);
const {privateKey,publicKey}=generateKeyPairSync("ec",{namedCurve:"P-256",privateKeyEncoding:{type:"pkcs8",format:"pem"},publicKeyEncoding:{type:"spki",format:"pem"}});
const credential=worker.createSignedWorkerCredential({issuer:"urn:example:worker",subject:"synthetic-worker",resolvePrivateKey:()=>privateKey});
let output="";let errors="";
const code=await worker.runCyrusHeadersHelper({servers:{commissioner:endpoint},resolveCredential:credential,env:{CLAUDE_CODE_MCP_SERVER_NAME:"commissioner",CLAUDE_CODE_MCP_SERVER_URL:endpoint},stdout:{write(value){output+=value;}},stderr:{write(value){errors+=value;}}});
assert.equal(code,0);assert.equal(errors,"");
const token=JSON.parse(output).Authorization.slice(7);const [header,payload,signature]=token.split(".");
assert.equal(JSON.parse(Buffer.from(header,"base64url")).alg,"ES256");
assert.equal(verify("sha256",Buffer.from(header+"."+payload),{key:publicKey,dsaEncoding:"ieee-p1363"},Buffer.from(signature,"base64url")),true);
const claims=JSON.parse(Buffer.from(payload,"base64url"));
assert.equal(claims.iss,"urn:example:worker");assert.equal(claims.sub,"synthetic-worker");assert.equal(claims.aud,endpoint);assert.equal(claims.exp-claims.iat,300);
let custodyReached=false;output="";
assert.equal(await worker.runCyrusHeadersHelper({servers:{commissioner:endpoint},resolveCredential(){custodyReached=true;return "unused";},env:{CLAUDE_CODE_MCP_SERVER_NAME:"commissioner",CLAUDE_CODE_MCP_SERVER_URL:"https://wrong.example/mcp"},stdout:{write(value){output+=value;}},stderr:{write(){}}}),1);
assert.equal(custodyReached,false);assert.equal(output,"");
console.log(JSON.stringify({passed:true,version:manifest.version,gitHead:manifest.gitHead,standaloneWorker:true,exactWorkerGrants:true,realSignedHeader:true,wrongDestinationDeniesCustody:true,noPackageInstall:true,node:process.version,platform:process.platform,arch:process.arch}));
`,
      workerStage,
    ],
    {
      cwd: workerStage,
      env: { PATH: process.env.PATH, HOME: workerStage, TMPDIR: workerStage },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  await writeFile(join(workerStage, "worker-consumer-result.json"), result.stdout);
  process.stdout.write(result.stdout);
  process.exit(0);
}
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
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const privateKeyFile = join(stage, "synthetic-worker-private.pem");
const publicKeyFile = join(stage, "synthetic-worker-public.pem");
await writeFile(privateKeyFile, keys.privateKey.export({ type: "pkcs8", format: "pem" }), {
  mode: 0o600,
});
await writeFile(publicKeyFile, keys.publicKey.export({ type: "spki", format: "pem" }));
const modes = [];
for (const mode of ["neutral", "cyrus", "signed"]) {
  const config = {
    EXAMPLE_WORKER_MODE: mode === "signed" ? "cyrus" : mode,
    EXAMPLE_DATA_DIR: join(stage, "application-data"),
    EXAMPLE_OWNER_PASSWORD: "synthetic-owner-only",
    EXAMPLE_WORKER_TOKEN: mode === "signed" ? "" : "synthetic-worker-only",
    EXAMPLE_WORKER_AUTH: mode === "signed" ? "signed" : "bearer",
    ...(mode === "signed"
      ? {
          EXAMPLE_WORKER_ISSUER: "urn:example:worker",
          EXAMPLE_WORKER_PUBLIC_KEY_FILE: publicKeyFile,
          EXAMPLE_WORKER_PRIVATE_KEY_FILE: privateKeyFile,
        }
      : {}),
    ...(mode !== "neutral"
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
  if (mode === "signed") {
    run(process.execPath, ["scripts/worker-artifacts.mjs"], consumer, config);
    const headers = JSON.parse(
      run(process.execPath, ["scripts/headers-helper.mjs"], consumer, {
        CLAUDE_CODE_MCP_SERVER_NAME: "commissioner",
        CLAUDE_CODE_MCP_SERVER_URL: config.EXAMPLE_MCP_ENDPOINT,
      }),
    );
    const { createSignedWorkerAuthenticator } = await import(
      pathToFileURL(join(installedRoot, manifest.exports["./auth"].import)).href
    );
    const verify = createSignedWorkerAuthenticator({
      issuer: config.EXAMPLE_WORKER_ISSUER,
      subject: "example:builder",
      audience: config.EXAMPLE_MCP_ENDPOINT,
      publicKeys: [await readFile(publicKeyFile, "utf8")],
    });
    assert.deepEqual(await verify(new Request(config.EXAMPLE_MCP_ENDPOINT, { headers })), {
      verified: true,
      principalId: "example:builder",
    });
  }
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
