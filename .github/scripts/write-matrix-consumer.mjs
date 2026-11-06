// write-matrix-consumer.mjs <consumer_dir> <repo> <commit_sha> <pnpm> <eve> <ref_mode>
//
// Writes a consumer project that depends on all four packages from GitHub at once, next to the given eve, the way an
// agent does: github: specs with &path:, strict peer checking, allowBuilds that deny better-sqlite3's build and allow
// only each package's own prepare build, keyed to the commit. <ref_mode> `commit` names each package by the commit;
// `tags` names it by its release tag, `<package>--v<version>`, which the caller has checked points at the commit.
// The agent itself (consumer-agent/) is copied in by the caller.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [consumerDir, repo, sha, pnpm, eve, refMode] = process.argv.slice(2);
if (refMode !== "commit" && refMode !== "tags") throw new Error(`unknown ref mode: ${refMode}`);

const dependencies = {};
const builds = { "better-sqlite3": false };
for (const dir of readdirSync("packages").sort()) {
  const packageDir = `packages/${dir}`;
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  const ref = refMode === "tags" ? `${dir}--v${manifest.version}` : sha;
  dependencies[manifest.name] = `github:${repo}#${ref}&path:${packageDir}`;
  const tarball = `https://codeload.github.com/${repo}/tar.gz/${sha}#path:${packageDir}`;
  builds[`${manifest.name}@${tarball}`] = true;
}
// eve's own peer, and the native module the commissioning extension keeps external, as an agent declares them.
const memory = JSON.parse(readFileSync("packages/memory/package.json", "utf8"));
dependencies.ai = memory.devDependencies.ai;
dependencies["better-sqlite3"] = memory.dependencies["better-sqlite3"];
dependencies.eve = eve;

const consumer = {
  name: "consumer",
  private: true,
  type: "module",
  packageManager: pnpm,
  dependencies,
};
writeFileSync(join(consumerDir, "package.json"), `${JSON.stringify(consumer, null, 2)}\n`);
writeFileSync(
  join(consumerDir, "pnpm-workspace.yaml"),
  `strictPeerDependencies: true\nallowBuilds:\n${Object.entries(builds)
    .map(([key, allow]) => `  ${JSON.stringify(key)}: ${allow}\n`)
    .join("")}minimumReleaseAge: 0\n`,
);
