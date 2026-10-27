import { writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { requiredEnv } from "./env.js";

// Separate fault-control runs only. The packed candidate and generated artifact stay unchanged.
function crash(boundary: string): never {
  writeFileSync(requiredEnv("FIXTURE_FAULT_MARKER"), `${boundary}\n`);
  process.kill(process.pid, "SIGKILL");
  throw new Error("Unreachable");
}
if (process.env.FIXTURE_FAULT_BEFORE_ACK === "1") {
  const prepare = Database.prototype.prepare;
  Database.prototype.prepare = function (this: Database.Database, sql: string) {
    const statement = prepare.call(this, sql) as Database.Statement<unknown[]>;
    if (sql.startsWith("UPDATE outbox SET delivered=1")) {
      const run = statement.run.bind(statement);
      statement.run = (...args: unknown[]) => {
        // Activation is acknowledged normally; inject only after a question's native owner send.
        const lookup = prepare.call(
          this,
          "SELECT kind FROM outbox WHERE seq=?",
        ) as Database.Statement<unknown[], { kind?: string }>;
        const entry = lookup.get(args[0]);
        if (entry?.kind === "question") crash("after-native-send-before-ack");
        return run(...args);
      };
    }
    return statement;
  } as typeof prepare;
}
const afterCommit = process.env.FIXTURE_FAULT_AFTER_COMMIT;
if (afterCommit === "question" || afterCommit === "decision") {
  const transaction = Database.prototype.transaction;
  Database.prototype.transaction = function <F extends (...args: never[]) => unknown>(callback: F) {
    const original = transaction.call(this, callback);
    const wrap =
      (execute: (...args: never[]) => unknown) =>
      (...args: never[]) => {
        const result = execute(...args);
        let shouldCrash = false;
        try {
          shouldCrash = Boolean(
            this.prepare(
              afterCommit === "question"
                ? "SELECT 1 FROM questions WHERE id='crash-question'"
                : "SELECT 1 FROM questions WHERE id='decision-question' AND answer IS NOT NULL",
            ).get(),
          );
        } catch {
          /* Initialization has no questions table yet. */
        }
        if (shouldCrash)
          crash(
            afterCommit === "question"
              ? "after-question-commit-before-dispatch"
              : "after-decision-commit-before-tool-response",
          );
        return result;
      };
    return Object.assign(wrap(original), {
      deferred: wrap(original.deferred),
      immediate: wrap(original.immediate),
      exclusive: wrap(original.exclusive),
      default: wrap(original.default),
      database: this,
    }) as ReturnType<typeof transaction<F>>;
  };
}
