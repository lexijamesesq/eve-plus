// The eve-memory-migrate command, as a function of its arguments and streams, so it can be run and tested without a
// process of its own. migrate-cli.ts wires it to the process.
//
//   eve-memory-migrate <dir> [--report -] [--refs <file>]
//     Dry run. Plans every store under <dir> on a copy, tries each clash's options there, and prints the report with
//     no detail values. With --report -, it prints the full report (values included) as JSON on stdout, for choosing
//     from, and the report without values on stderr.
//   eve-memory-migrate <dir> --apply --report <file> --choose "c1=A c2=Q:\"Sam (Acme)\"" [--refs <file>]
//     Apply the choices against the full report they were made from. The agents using the stores must be stopped.
//     Prints each decision it read, then the result.
//
// --refs names `knowledge:` references held elsewhere (one per line), checked in every store alongside the store's
// own; apply reuses each store's from the dry run when given none. `-` for --report or --refs reads stdin, so a
// container needs no host file. Exits 0 when it ran (per-clash outcomes are in the report), 1 when it refused before
// writing, 2 on bad usage.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { handleOf } from "./memory-graph.js";
import {
  applyScope,
  chosen,
  dryRun,
  newRun,
  numbered,
  preflight,
  type Report,
  redacted,
} from "./migrate.js";
import { scopesIn } from "./stats.js";

export interface Io {
  stdin: () => string;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

const USAGE =
  "usage: eve-memory-migrate <dir> [--report -] [--refs <file>]\n" +
  "       eve-memory-migrate <dir> --apply --report <file> --choose <choices> [--refs <file>]\n";

class Exit {
  constructor(readonly code: number) {}
}

const lines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim().replace(/^knowledge:/, ""))
    .filter(Boolean);

export async function main(argv: string[], io: Io): Promise<number> {
  try {
    await run(argv, io);
    return 0;
  } catch (e) {
    if (e instanceof Exit) return e.code;
    throw e;
  }
}

async function run(argv: string[], io: Io) {
  const usage = (): never => {
    io.stderr(USAGE);
    throw new Exit(2);
  };
  const parsed = (() => {
    try {
      return parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
          apply: { type: "boolean" },
          report: { type: "string" },
          choose: { type: "string" },
          refs: { type: "string" },
        },
      });
    } catch {
      return usage();
    }
  })();
  const { values: opt, positionals } = parsed;
  const dir = positionals[0];
  if (dir === undefined || positionals.length > 1) usage();
  if (opt.apply && !(opt.report && opt.choose !== undefined)) usage();
  if (!opt.apply && (opt.choose !== undefined || (opt.report !== undefined && opt.report !== "-")))
    usage();
  // stdin feeds one input at most.
  if (opt.refs === "-" && opt.report === "-" && opt.apply) usage();

  const { version } = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  // `-` reads stdin, so a tool run in a container needs no file of the host's.
  const read = (path: string) => (path === "-" ? io.stdin() : readFileSync(path, "utf8"));
  const refuse = (why: string): never => {
    io.stdout(`eve-memory-migrate ${version} refused: ${why}\n`);
    throw new Exit(1);
  };
  const given = opt.refs ? lines(read(opt.refs)) : undefined;
  const scopes = (() => {
    try {
      return scopesIn(dir);
    } catch (error) {
      return refuse(`can't read ${dir} (${(error as NodeJS.ErrnoException).code ?? error})`);
    }
  })();

  if (!opt.apply) {
    const report = numbered({ mode: "dry-run", dir, version, scopes: [] });
    for (const scope of scopes)
      report.scopes.push(await dryRun(join(dir, scope), scope, given ?? []));
    numbered(report);
    if (opt.report === "-") {
      // The full report on stdout and the shareable one on stderr, for a caller that keeps them apart.
      io.stdout(`${JSON.stringify(report, null, 2)}\n`);
      io.stderr(`${redacted(report)}\n`);
    } else io.stdout(`${redacted(report)}\n`);
    return;
  }

  const from = JSON.parse(read(opt.report as string)) as Report;
  // Each store's references as its dry run checked them: the given ones plus those in its own details. A store's
  // own references are never checked against another store.
  const byScope = new Map(from.scopes.map((s) => [s.scope, s.refs.map((r) => r.ref)]));
  const refsOf = (scope: string) => given ?? byScope.get(scope) ?? [];
  const { decisions, problems } = chosen(from, opt.choose as string);
  if (problems.length) refuse(problems.join("; "));
  for (const d of decisions) {
    const qualifies = Object.entries(d.members ?? {}).flatMap(([id, ch]) =>
      typeof ch === "object" && "qualify" in ch
        ? [`${id} as ${JSON.stringify(ch.qualify)} → knowledge:${handleOf(ch.qualify)}`]
        : [],
    );
    io.stdout(
      `decision ${d.clash} digest=${d.digest} ${d.skip ? "skip" : JSON.stringify({ members: d.members, keys: d.keys, drop: d.drop })}${qualifies.length ? ` qualifies ${qualifies.join("; ")}` : ""}\n`,
    );
  }
  const errors: string[] = [];
  for (const d of decisions)
    if (!scopes.some((scope) => d.clash.startsWith(`${scope}/`)))
      errors.push(`${d.clash}: no store under ${dir} has that scope`);
  for (const scope of scopes) {
    const checked = await preflight(
      join(dir, scope),
      scope,
      decisions.filter((d) => d.clash.startsWith(`${scope}/`)),
    );
    errors.push(...checked.errors);
    for (const n of checked.notes) io.stdout(`note ${n}\n`);
  }
  if (errors.length) refuse(errors.join("; "));
  const runId = newRun();
  const report: Report = { mode: "apply", dir, version, scopes: [] };
  for (const scope of scopes)
    report.scopes.push(
      await applyScope(
        join(dir, scope),
        scope,
        decisions.filter((d) => d.clash.startsWith(`${scope}/`)),
        refsOf(scope),
        runId,
      ),
    );
  numbered(report);
  io.stdout(`${redacted(report)}\n`);
}
