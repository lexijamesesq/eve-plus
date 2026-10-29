#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createSignedWorkerCredential } from "@eve-plus/commissioning/auth";
import { runCyrusHeadersHelper } from "@eve-plus/commissioning/cyrus";

const settings = JSON.parse(
  await readFile(new URL("./worker-settings.json", import.meta.url), "utf8"),
);
process.exitCode = await runCyrusHeadersHelper({
  servers: settings.servers,
  resolveCredential: settings.signedCredential
    ? createSignedWorkerCredential({
        algorithm: settings.signedCredential.algorithm,
        issuer: settings.signedCredential.issuer,
        subject: settings.signedCredential.subject,
        lifetimeSeconds: settings.signedCredential.lifetimeSeconds,
        resolvePrivateKey: () => readFile(settings.signedCredential.privateKeyFile, "utf8"),
      })
    : async () => {
        // This demo uses a private credential file. Replace with your existing secret provider.
        return (await readFile(settings.credentialFile, "utf8")).trim();
      },
});
