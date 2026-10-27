import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createDispatcher } from "../../src/dispatch.js";
import { CommissionStore } from "../../src/store.js";
import extension from "../extension.js";

const runtimes = new Map<
  string,
  { store: CommissionStore; drain: ReturnType<typeof createDispatcher> }
>();
export function runtime() {
  const config = extension.config;
  const path = join(config.dataDir, config.namespace, "commissions.sqlite");
  let value = runtimes.get(path);
  if (!value) {
    mkdirSync(join(config.dataDir, config.namespace), { recursive: true, mode: 0o700 });
    const store = new CommissionStore(path, { overdueAfterMs: config.overdueAfterMs });
    value = { store, drain: createDispatcher(store, config) };
    runtimes.set(path, value);
  }
  return value;
}
