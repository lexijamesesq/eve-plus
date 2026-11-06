// write-consumer.mjs <consumer_dir> <repo> <pnpm> <eve> <package_dir>#<ref>...
//
// Writes an empty consumer project that depends on the given packages the way real consumers do: a github: spec with
// &path: for each, eve at the given version beside its `ai` peer, and better-sqlite3, which the commissioning
// extension keeps external, at the versions the packages pin. It checks peers strictly, denies better-sqlite3's build
// (its prebuilt binding must load) and allows only each package's own prepare build, keyed to the commit its ref
// names. A ref is a commit SHA or a release tag, resolved to its own commit on GitHub, so packages released from
// different commits can be installed together. Like the consumers it stands in for, it sets no release-age gate.
// Prints the package names, one per line.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [consumerDir, repo, pnpm, eve, ...entries] = process.argv.slice(2);
const read = (packageDir) => JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));

function commitOf(ref) {
  if (/^[0-9a-f]{40}$/.test(ref)) return ref;
  const peeled = execFileSync(
    "git",
    ["ls-remote", "--tags", `https://github.com/${repo}.git`, `refs/tags/${ref}^{}`],
    { encoding: "utf8" },
  ).split("\t")[0];
  if (!/^[0-9a-f]{40}$/.test(peeled)) throw new Error(`${ref} is not an annotated tag on ${repo}`);
  return peeled;
}

const memory = read("packages/memory");
const dependencies = {
  ai: memory.devDependencies.ai,
  "better-sqlite3": memory.dependencies["better-sqlite3"],
  eve,
};
const builds = { "better-sqlite3": false };
const names = [];
for (const entry of entries) {
  const [packageDir, ref] = entry.split("#");
  const { name } = read(packageDir);
  dependencies[name] = `github:${repo}#${ref}&path:${packageDir}`;
  const tarball = `https://codeload.github.com/${repo}/tar.gz/${commitOf(ref)}#path:${packageDir}`;
  builds[`${name}@${tarball}`] = true;
  names.push(name);
}

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
process.stdout.write(`${names.join("\n")}\n`);
