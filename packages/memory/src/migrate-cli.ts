#!/usr/bin/env node
// eve-memory-migrate: the command in migrate-main.ts, run as this process. See there for usage.

import { readFileSync } from "node:fs";

import { main } from "./migrate-main.js";

process.exitCode = await main(process.argv.slice(2), {
  stdin: () => readFileSync(0, "utf8"),
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
});
