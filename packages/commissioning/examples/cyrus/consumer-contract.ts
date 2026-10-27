import commissioning from "@eve-plus/commissioning";
import type { CommissioningConfig } from "@eve-plus/commissioning/config";
import {
  createCyrusWorkerArtifacts,
  cyrus,
  runCyrusHeadersHelper,
} from "@eve-plus/commissioning/cyrus";
import type { CommissionStore } from "@eve-plus/commissioning/store";
import { decide, open, read } from "@eve-plus/commissioning/tools";
import { createDispatcher, type OwnerDelivery } from "@eve-plus/commissioning/transport";

// Typecheck public declarations from the installed tarball, including trusted host seams.
export function checkContract(config: CommissioningConfig, store: CommissionStore) {
  const mount = commissioning(config);
  const drain = createDispatcher(store, config);
  const deliver = async (_delivery: OwnerDelivery) => {};
  return {
    mount,
    drain: () => drain(deliver),
    open,
    read,
    decide,
    cyrus,
    createCyrusWorkerArtifacts,
    runCyrusHeadersHelper,
  };
}
