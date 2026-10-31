// write-consumer.mjs <package_dir> <consumer_dir> <repo> <commit_sha> <pnpm>
//
// Writes an empty consumer project that depends on the package the way real consumers do: a github: spec with
// &path:, eve at the version the package is built against, and allowBuilds that deny better-sqlite3's build (its
// prebuilt binding must load) and allow only the package's own prepare build, keyed to the commit. Like the
// consumers it stands in for, it sets no release-age gate.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [packageDir, consumerDir, repo, sha, pnpm] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));

const consumer = {
  name: "consumer",
  private: true,
  type: "module",
  packageManager: pnpm,
  dependencies: {
    [manifest.name]: `github:${repo}#${sha}&path:${packageDir}`,
    eve: manifest.devDependencies.eve,
  },
};
writeFileSync(join(consumerDir, "package.json"), `${JSON.stringify(consumer, null, 2)}\n`);

const buildKey = `${manifest.name}@https://codeload.github.com/${repo}/tar.gz/${sha}#path:${packageDir}`;
writeFileSync(
  join(consumerDir, "pnpm-workspace.yaml"),
  `allowBuilds:\n  better-sqlite3: false\n  ${JSON.stringify(buildKey)}: true\nminimumReleaseAge: 0\n`,
);
process.stdout.write(manifest.name);
