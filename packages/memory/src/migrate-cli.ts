#!/usr/bin/env node
// eve-memory-migrate <dir>: give the records of stores saved before handles their handles.
//
//   eve-memory-migrate <dir> [--report <file>] [--refs <file>]
//     Dry run. Plans every store under <dir> on a copy, tries each clash's options there, and prints the report with
//     no detail values. --report writes the full report (values included) as JSON, for choosing from.
//   eve-memory-migrate <dir> --apply --report <file> --choose "c1=A c2=Q:\"Sam (Acme)\"" [--refs <file>] [--run <id>]
//   eve-memory-migrate <dir> --apply --decisions <file> [--refs <file>] [--run <id>]
//     Apply. The agents using the stores must be stopped. Prints each decision it read, then the result.
//
// --refs names `knowledge:` references held elsewhere (one per line), checked before and after alongside the stores'
// own. Exits 0 when it ran (per-clash outcomes are in the report), 1 when it refused before writing, 2 on bad usage.

import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { handleOf } from "./memory-graph.js";
import {
  applyScope,
  chosen,
  type Decision,
  dryRun,
  newRun,
  numbered,
  preflight,
  type Report,
  redacted,
} from "./migrate.js";
import { scopesIn } from "./stats.js";

const usage = (): never => {
  process.stderr.write(
    "usage: eve-memory-migrate <dir> [--report <file>] [--refs <file>]\n" +
      "       eve-memory-migrate <dir> --apply (--report <file> --choose <choices> | --decisions <file>) [--refs <file>] [--run <id>]\n",
  );
  process.exit(2);
};

const parse = () =>
  parseArgs({
    allowPositionals: true,
    options: {
      apply: { type: "boolean" },
      report: { type: "string" },
      choose: { type: "string" },
      decisions: { type: "string" },
      refs: { type: "string" },
      run: { type: "string" },
    },
  });
const { values: opt, positionals } = (() => {
  try {
    return parse();
  } catch {
    return usage();
  }
})();
const dir = positionals[0];
if (dir === undefined || positionals.length > 1) usage();
if (opt.apply && !opt.decisions && !(opt.report && opt.choose)) usage();
if (!opt.apply && (opt.choose || opt.decisions || opt.run)) usage();

const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
  version: string;
};
const refs = opt.refs
  ? readFileSync(opt.refs, "utf8")
      .split("\n")
      .map((l) => l.trim().replace(/^knowledge:/, ""))
      .filter(Boolean)
  : [];
const refuse = (why: string) => {
  process.stdout.write(`eve-memory-migrate ${version} refused: ${why}\n`);
  process.exit(1);
};

const scopes = (() => {
  try {
    return scopesIn(dir);
  } catch (error) {
    return refuse(`can't read ${dir} (${(error as NodeJS.ErrnoException).code ?? error})`);
  }
})();

if (!opt.apply) {
  const report = numbered({ mode: "dry-run", dir, version, scopes: [] });
  for (const scope of scopes) report.scopes.push(await dryRun(join(dir, scope), scope, refs));
  numbered(report);
  if (opt.report) {
    writeFileSync(opt.report, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    // The mode applies only to a file this creates: an existing one is narrowed too.
    chmodSync(opt.report, 0o600);
  }
  process.stdout.write(`${redacted(report)}\n`);
} else {
  let decisions: Decision[];
  if (opt.decisions) decisions = JSON.parse(readFileSync(opt.decisions, "utf8")) as Decision[];
  else {
    const from = JSON.parse(readFileSync(opt.report as string, "utf8")) as Report;
    const { decisions: d, problems } = chosen(from, opt.choose as string);
    if (problems.length) refuse(problems.join("; "));
    decisions = d;
  }
  for (const d of decisions) {
    const qualifies = Object.entries(d.members ?? {}).flatMap(([id, ch]) =>
      typeof ch === "object" && "qualify" in ch
        ? [`${id} as ${JSON.stringify(ch.qualify)} → knowledge:${handleOf(ch.qualify)}`]
        : [],
    );
    process.stdout.write(
      `decision ${d.clash} digest=${d.digest} ${d.skip ? "skip" : JSON.stringify({ members: d.members, keys: d.keys, drop: d.drop })}${qualifies.length ? ` qualifies ${qualifies.join("; ")}` : ""}\n`,
    );
  }
  const errors: string[] = [];
  for (const scope of scopes) {
    const checked = await preflight(
      join(dir, scope),
      scope,
      decisions.filter((d) => d.clash.startsWith(`${scope}/`)),
    );
    errors.push(...checked.errors);
    for (const n of checked.notes) process.stdout.write(`note ${n}\n`);
  }
  if (errors.length) refuse(errors.join("; "));
  const run = opt.run ?? newRun();
  const report: Report = { mode: "apply", dir, version, scopes: [] };
  for (const scope of scopes)
    report.scopes.push(
      await applyScope(
        join(dir, scope),
        scope,
        decisions.filter((d) => d.clash.startsWith(`${scope}/`)),
        refs,
        run,
      ),
    );
  numbered(report);
  process.stdout.write(`${redacted(report)}\n`);
}
