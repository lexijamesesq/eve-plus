import { chmod, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createCyrusWorkerArtifacts } from "@eve-plus/commissioning/cyrus";

const endpoint = process.env.EXAMPLE_MCP_ENDPOINT;
const credentialFile = process.env.EXAMPLE_WORKER_CREDENTIAL_FILE;
if (!endpoint || !credentialFile)
  throw new Error("Supply EXAMPLE_MCP_ENDPOINT and EXAMPLE_WORKER_CREDENTIAL_FILE");
await writeFile(
  "scripts/worker-settings.json",
  `${JSON.stringify(
    {
      servers: { commissioner: endpoint },
      credentialFile: resolve(credentialFile),
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);
await chmod("scripts/headers-helper.mjs", 0o700);
const artifacts = createCyrusWorkerArtifacts({
  servers: { commissioner: endpoint },
  headersHelperPath: resolve("scripts/headers-helper.mjs"),
});
await writeFile("mcp.json", `${JSON.stringify(artifacts.mcpConfig, null, 2)}\n`, { mode: 0o600 });
await writeFile("worker-instructions.md", `${artifacts.instructions}\n`);
await writeFile(
  "worker-allowed-tools.json",
  `${JSON.stringify(artifacts.allowedTools, null, 2)}\n`,
);
console.log(
  "Wrote mcp.json, worker-instructions.md and worker-allowed-tools.json; no credential was materialized.",
);
