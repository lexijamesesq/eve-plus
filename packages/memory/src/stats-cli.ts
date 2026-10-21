#!/usr/bin/env node
// eve-memory-stats <dir>: read-only facts about every memory store under <dir>, one line each. It reports and never
// judges a deploy: it exits 0 whenever it ran, including when a store or the directory is unreadable, and 2 only on
// bad usage.

import { existsSync, readFileSync, statSync } from "node:fs";

import { formatStats, scopeStats, scopesIn, statsHeader } from "./stats.js";

const dir = process.argv[2];
if (dir === undefined || process.argv.length > 3) {
  process.stderr.write(
    "usage: eve-memory-stats <dir>  (the memory directory, e.g. /data/memory)\n",
  );
  process.exit(2);
}
const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
  version: string;
};
try {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    process.stdout.write(`${statsHeader(dir, version, 0, "no such directory")}\n`);
  } else {
    process.stdout.write(
      `${formatStats(
        dir,
        scopesIn(dir).map((s) => scopeStats(dir, s)),
        version,
      )}\n`,
    );
  }
} catch (error) {
  // A directory that can't be listed is a finding about the store, reported like the rest, never a crash.
  const reason = (error as NodeJS.ErrnoException).code ?? String(error);
  process.stdout.write(`${statsHeader(dir, version, 0, `can't read the directory (${reason})`)}\n`);
}
