import { join } from "node:path";
import { createDispatcher } from "../../src/dispatch.js";
import { CommissionStore } from "../../src/store.js";
import extension from "../extension.js";

let value:
  | {
      store: CommissionStore;
      config: typeof extension.config;
      drain: ReturnType<typeof createDispatcher>;
    }
  | undefined;
/** The mount's one store and dispatcher, opened on first use. */
export function runtime() {
  if (!value) {
    const config = extension.config;
    const store = new CommissionStore(
      join(config.dataDir, config.namespace, "commissions.sqlite"),
      {
        overdueAfterMs: config.overdueAfterMs,
      },
    );
    value = { store, config, drain: createDispatcher(store, config) };
  }
  return value;
}
