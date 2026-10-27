#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { runCyrusHeadersHelper } from "@eve-plus/commissioning/cyrus";

const settings = JSON.parse(
  await readFile(new URL("./worker-settings.json", import.meta.url), "utf8"),
);
process.exitCode = await runCyrusHeadersHelper({
  servers: settings.servers,
  resolveCredential: async () => {
    // This demo uses a private credential file. Replace with your existing secret provider.
    return (await readFile(settings.credentialFile, "utf8")).trim();
  },
});
