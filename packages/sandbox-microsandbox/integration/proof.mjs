// Real-VM proof for @eve-plus/sandbox-microsandbox. Runs inside the throwaway container that
// run.sh starts on a KVM host, against the installed package. Prints one PASS or FAIL line per
// probe. Phase "a" runs every probe and records one session; phase "b" is a new process that
// resumes it, then cleans up.
import { spawn as spawnChild } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { SandboxSessionGoneError, SandboxTemplateNotProvisionedError } from "eve/sandbox/provider";
import { Sandbox, Snapshot } from "microsandbox";

const pkg = "./node_modules/@eve-plus/sandbox-microsandbox/dist";
const { createImplementation, NetworkPolicyConflictError } = await import(`${pkg}/provider.js`);
const { UnsupportedNetworkPolicyError } = await import(`${pkg}/network-policy.js`);

const ALPINE =
  "alpine:3.22@sha256:2e0b81d60597f449baa56dc25d355367869d2dca4cd57e866f1e2b52af3eb55f";
const STATE_FILE = "/home/node/proof-state.json";
const phase = process.argv[2] ?? "a";
const results = [];
const record = (ok, name, detail = "") => {
  const line = `${ok ? "PASS" : "FAIL"} ${name} ${String(detail).replace(/\s+/g, " ").slice(0, 160)}`;
  results.push(ok);
  console.log(line);
};
const probe = async (name, fn) => {
  try {
    const [ok, detail] = await fn();
    record(ok, name, detail);
  } catch (error) {
    record(false, name, `threw ${error?.name}: ${error?.message}`);
  }
};
const rejectsWith = async (promise, ErrorType) => {
  try {
    await promise;
    return [false, "resolved"];
  } catch (error) {
    return [error instanceof ErrorType, `${error?.name}: ${error?.message}`];
  }
};

const encode = (text) => new TextEncoder().encode(text);
const decode = (bytes) => new TextDecoder().decode(bytes);
const run = async (connection, command, options = {}) => {
  const child = await connection.spawn({
    abortSignal: options.signal,
    command,
    env: options.env ?? {},
    workingDirectory: options.cwd ?? "/workspace",
  });
  const [out, err, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.wait(),
  ]);
  return { code: status.exitCode, err: err.trim(), out: out.trim() };
};
// curl exits 0 with an HTTP status when it reached the host.
const reaches = async (connection, args) => {
  const r = await run(connection, `curl -sS -o /dev/null -w '%{http_code}' --max-time 8 ${args}`);
  return { reached: r.code === 0 && /^[1-5]\d\d$/.test(r.out), detail: r.out || r.err };
};
const sessionCtx = (id) => ({
  kind: "session",
  resolveProjectPath: (path) => path,
  session: { id },
  storagePath: "/home/node/storage",
});
const prepareCtx = ({ salt = "proof", populate } = {}) => ({
  files: {},
  isEmpty: false,
  log: (message) => console.log(`  log ${message}`),
  resolveProjectPath: (path) => path,
  resourcesDirectory: async () => undefined,
  storagePath: "/home/node/storage",
  templateKey: (identity) =>
    createHash("sha256").update(JSON.stringify({ identity, salt })).digest("hex"),
  // Stands in for eve's populate: seed a workspace file, then run an authored prepare that
  // needs the network, which the template build allows.
  async populate(connection) {
    await connection.writeFiles({
      files: [{ path: "/workspace/seed.txt", content: encode("seeded") }],
    });
    const r = await run(
      connection,
      "apt-get update -qq && apt-get install -y -qq curl dnsutils >/dev/null && echo installed",
    );
    if (!r.out.includes("installed")) throw new Error(`authored prepare failed: ${r.err}`);
    await populate?.(connection);
  },
});
const sandboxNames = async () => (await Sandbox.list()).sandboxes.map((handle) => handle.name);
const snapshotDigests = async () => (await Snapshot.list()).map((entry) => entry.digest).sort();
const runChild = (args, env = {}) =>
  new Promise((resolve) => {
    const child = spawnChild(process.execPath, args, { env: { ...process.env, ...env } });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("close", (code) => resolve({ code, out: out.trim() }));
  });

const provider = createImplementation({});

if (phase === "a") {
  // prepare
  let artifact;
  await probe("prepare-returns-disk-snapshot-artifact", async () => {
    artifact = await provider.prepare(prepareCtx());
    const ok =
      typeof artifact.snapshot?.digest === "string" &&
      typeof artifact.templateKey === "string" &&
      artifact.msbVersion === "0.7.10";
    return [ok, JSON.stringify(artifact)];
  });
  if (artifact === undefined) process.exit(1);
  writeFileSync("/home/node/artifact.json", JSON.stringify(artifact));
  await probe("prepare-leaves-no-build-sandbox", async () => {
    const names = await sandboxNames();
    return [!names.some((name) => name.startsWith("eve-plus-tpl-")), JSON.stringify(names)];
  });
  await probe("prepare-reuses-cached-template", async () => {
    const again = await provider.prepare(prepareCtx());
    return [again.snapshot.digest === artifact.snapshot.digest, again.snapshot.digest];
  });
  await probe("prepare-fails-clearly-without-bash-and-leaves-nothing", async () => {
    const before = await snapshotDigests();
    const [rejected, detail] = await rejectsWith(
      createImplementation({ image: ALPINE }).prepare(prepareCtx({ salt: "alpine" })),
      Error,
    );
    const names = await sandboxNames();
    const clean = !names.some((name) => name.startsWith("eve-plus-tpl-"));
    const same = JSON.stringify(before) === JSON.stringify(await snapshotDigests());
    return [rejected && /must provide bash/.test(detail) && clean && same, detail];
  });
  await probe("prepare-failure-in-populate-leaves-nothing", async () => {
    const before = await snapshotDigests();
    const failing = prepareCtx({
      salt: "populate-fails",
      populate: async () => {
        throw new Error("authored prepare broke");
      },
    });
    const [rejected, detail] = await rejectsWith(provider.prepare(failing), Error);
    const names = await sandboxNames();
    const clean = !names.some((name) => name.startsWith("eve-plus-tpl-"));
    const same = JSON.stringify(before) === JSON.stringify(await snapshotDigests());
    return [rejected && clean && same, `${detail}; sandboxes ${JSON.stringify(names)}`];
  });

  // A bare open(): eve passes undefined options to start().
  const bare = await provider.start(sessionCtx("bare-open"), undefined, artifact);
  const c = bare.connection;
  await probe("bare-open-config-deny-all-no-tls-no-timeouts-1cpu-1gib", async () => {
    const config = JSON.parse((await Sandbox.get(bare.state.sandboxName)).configJson);
    const ok =
      config.network.policy.default_egress === "deny" &&
      config.network.tls.enabled === false &&
      config.lifecycle.idle_timeout_secs === null &&
      config.lifecycle.max_duration_secs === null &&
      config.resources.cpus === 1 &&
      config.resources.memory_mib === 1024;
    return [
      ok,
      JSON.stringify({
        policy: config.network.policy,
        tls: config.network.tls.enabled,
        lifecycle: config.lifecycle,
        resources: config.resources,
      }),
    ];
  });
  await probe("deny-all-blocks-host", async () => {
    const r = await reaches(c, "https://example.com");
    return [!r.reached, r.detail];
  });
  await probe("deny-all-blocks-direct-ip", async () => {
    const r = await reaches(c, "-k https://1.1.1.1");
    return [!r.reached, r.detail];
  });
  await probe("deny-all-blocks-ipv4-mapped-ipv6", async () => {
    const r = await reaches(c, "-k -g https://[::ffff:1.1.1.1]");
    return [!r.reached, r.detail];
  });
  await probe("deny-all-blocks-outside-dns", async () => {
    const r = await run(c, "dig +short +time=3 +tries=1 example.com A @1.1.1.1");
    return [!/^\d+\.\d+\.\d+\.\d+/m.test(r.out), r.out || r.err || "no answer"];
  });
  await probe("guest-trust-store-is-the-images-own", async () => {
    const r = await run(
      c,
      "ls /usr/local/share/ca-certificates | wc -l; test -f /etc/ssl/certs/ca-certificates.crt && echo bundle",
    );
    return [r.out.startsWith("0") && r.out.includes("bundle"), r.out];
  });

  // connection
  await probe("workspace-seeded-from-template", async () => {
    const bytes = await c.readFile({ path: "/workspace/seed.txt" });
    return [bytes !== null && decode(bytes) === "seeded", bytes === null ? "null" : decode(bytes)];
  });
  await probe("spawn-output-exit-cwd-env-agent-marker", async () => {
    const r = await run(c, 'echo "$PWD $GREETING $AI_AGENT"; echo oops >&2; exit 3', {
      cwd: "/tmp",
      env: { GREETING: "hi" },
    });
    return [r.out === "/tmp hi eve" && r.err === "oops" && r.code === 3, JSON.stringify(r)];
  });
  await probe("write-then-read-nested-file", async () => {
    await c.writeFiles({ files: [{ path: "/workspace/a/b/c.txt", content: encode("deep") }] });
    const bytes = await c.readFile({ path: "/workspace/a/b/c.txt" });
    return [bytes !== null && decode(bytes) === "deep", bytes === null ? "null" : decode(bytes)];
  });
  await probe("read-missing-is-null", async () => {
    const bytes = await c.readFile({ path: "/workspace/missing.txt" });
    return [bytes === null, String(bytes)];
  });
  await probe("read-directory-rejects", async () =>
    rejectsWith(c.readFile({ path: "/workspace/a" }), Error),
  );
  await probe("remove-path-file-force-recursive", async () => {
    await c.removePath({ path: "/workspace/a/b/c.txt" });
    const gone = (await c.readFile({ path: "/workspace/a/b/c.txt" })) === null;
    await c.removePath({ path: "/workspace/never", force: true });
    const [strict] = await rejectsWith(c.removePath({ path: "/workspace/never" }), Error);
    const [nonEmpty] = await rejectsWith(c.removePath({ path: "/workspace/a" }), Error);
    await c.removePath({ path: "/workspace/a", recursive: true });
    const dirGone =
      (await run(c, "test -e /workspace/a && echo there || echo gone")).out === "gone";
    return [
      gone && strict && nonEmpty && dirGone,
      JSON.stringify({ gone, strict, nonEmpty, dirGone }),
    ];
  });
  await probe("abort-kills-tree-including-background-grandchild", async () => {
    const controller = new AbortController();
    const child = await c.spawn({
      abortSignal: controller.signal,
      command: "sleep 300 & echo $! > /tmp/gc.pid; echo $$ > /tmp/sh.pid; wait",
      env: {},
      workingDirectory: "/workspace",
    });
    for (let i = 0; i < 50; i++) {
      if ((await run(c, "cat /tmp/sh.pid /tmp/gc.pid 2>/dev/null | wc -l")).out === "2") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    controller.abort();
    await child.wait().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const r = await run(
      c,
      'for p in $(cat /tmp/sh.pid /tmp/gc.pid); do kill -0 "$p" 2>/dev/null && echo alive || echo dead; done',
    );
    return [r.out === "dead\ndead", r.out];
  });

  // start: stopped and running sandboxes, concurrency
  await probe("start-reconnects-a-stopped-sandbox-with-its-files", async () => {
    await c.writeFiles({ files: [{ path: "/workspace/kept.txt", content: encode("kept") }] });
    await c.stop();
    await c.stop();
    const status = (await Sandbox.get(bare.state.sandboxName)).status;
    const again = await provider.start(
      sessionCtx("bare-open"),
      { networkPolicy: "allow-all" },
      artifact,
    );
    const bytes = await again.connection.readFile({ path: "/workspace/kept.txt" });
    const config = JSON.parse((await Sandbox.get(bare.state.sandboxName)).configJson);
    // The policy applies only at creation; a later open with another policy reuses the sandbox.
    const ok =
      status === "stopped" &&
      bytes !== null &&
      decode(bytes) === "kept" &&
      config.network.policy.default_egress === "deny";
    return [ok, `status after stop: ${status}; egress ${config.network.policy.default_egress}`];
  });
  await probe("concurrent-starts-yield-one-sandbox", async () => {
    const opened = await Promise.all(
      Array.from({ length: 4 }, () =>
        provider.start(sessionCtx("concurrent"), undefined, artifact),
      ),
    );
    const names = new Set(opened.map((o) => o.state.sandboxName));
    const count = (await sandboxNames()).filter((name) => names.has(name)).length;
    return [names.size === 1 && count === 1, `${names.size} name(s), ${count} sandbox(es)`];
  });
  await probe("two-process-starts-yield-one-sandbox", async () => {
    const [one, two] = await Promise.all([
      runChild(["start-child.mjs", "two-process"]),
      runChild(["start-child.mjs", "two-process"]),
    ]);
    const lines = [one, two].map((r) => r.out.split("\n").at(-1));
    const count = (await sandboxNames()).filter((name) => name === lines[0]).length;
    const ok = one.code === 0 && two.code === 0 && lines[0] === lines[1] && count === 1;
    return [ok, `exit ${one.code}/${two.code}; ${lines.join(" ")}; ${count} sandbox(es)`];
  });

  await probe("deny-all-open-of-an-allow-all-sandbox-is-refused", async () => {
    const conflictCtx = sessionCtx("policy-conflict");
    const open = await provider.start(conflictCtx, { networkPolicy: "allow-all" }, artifact);
    const [refused, detail] = await rejectsWith(
      provider.start(conflictCtx, undefined, artifact),
      NetworkPolicyConflictError,
    );
    await provider.onSessionEnd(conflictCtx, open.state, { reason: "completed" });
    return [refused, detail];
  });

  // allow-all
  await probe("allow-all-reaches-host", async () => {
    const open = await provider.start(
      sessionCtx("allow-all"),
      { networkPolicy: "allow-all" },
      artifact,
    );
    const r = await reaches(open.connection, "https://example.com");
    await provider.onSessionEnd(sessionCtx("allow-all"), open.state, { reason: "completed" });
    return [r.reached, r.detail];
  });

  // rejected shapes
  for (const [label, policy] of [
    ["empty-object", {}],
    ["allow-star-list", { allow: ["*"] }],
    ["allow-star-map", { allow: { "*": [] } }],
    ["allowlist", { allow: ["example.com"] }],
    ["transform", { allow: { "github.com": [{ transform: [{ headers: { a: "b" } }] }] } }],
    ["forward-url", { allow: { "github.com": [{ forwardURL: "https://p" }] } }],
    [
      "match",
      { allow: { "github.com": [{ match: { method: ["GET"] }, forwardURL: "https://p" }] } },
    ],
    ["subnets", { subnets: { deny: ["10.0.0.0/8"] } }],
  ]) {
    await probe(`rejects-policy-${label}-creating-nothing`, async () => {
      const ctx = sessionCtx(`rejected-${label}`);
      const before = await sandboxNames();
      const [rejected, detail] = await rejectsWith(
        provider.start(ctx, { networkPolicy: policy }, artifact),
        UnsupportedNetworkPolicyError,
      );
      const after = await sandboxNames();
      return [rejected && before.length === after.length, detail];
    });
  }

  // stale runtime: an older msb selected through MSB_PATH, then one sitting in MSB_HOME
  await probe("stale-runtime-via-msb-path-is-refused", async () => {
    const r = await runChild(["stale-child.mjs"], {
      MSB_PATH: "/home/node/stale/package/bin/msb",
      MSB_LIBKRUNFW_PATH: "/home/node/stale/package/lib/libkrunfw.so.5.6.1",
    });
    return [r.out.includes("refused MicrosandboxRuntimeMismatchError"), r.out];
  });
  await probe("stale-runtime-in-msb-home-never-runs", async () => {
    // The child's MSB_HOME holds the stale pair and no template. Either microsandbox prefers the
    // locked package (then start gets as far as the missing template), or the provider refuses.
    const r = await runChild(["stale-child.mjs"], { MSB_HOME: "/home/node/stale-home" });
    const lockedWins =
      r.out.includes("resolved sdk_package 0.7.10") &&
      r.out.includes("refused SandboxTemplateNotProvisionedError");
    const refused = r.out.includes("refused MicrosandboxRuntimeMismatchError");
    return [lockedWins || refused, r.out];
  });

  // gone session, idempotent end
  await probe("session-end-deletes-idempotently-then-resume-is-gone", async () => {
    const ctx = sessionCtx("concurrent");
    const state = (await provider.start(ctx, undefined, artifact)).state;
    await provider.onSessionEnd(ctx, state, { reason: "completed" });
    await provider.onSessionEnd(ctx, state, { reason: "completed" });
    await provider.onSessionEnd(sessionCtx("never-existed"), null, { reason: "deleted" });
    const [gone, detail] = await rejectsWith(
      provider.resume(ctx, artifact, state),
      SandboxSessionGoneError,
    );
    return [gone, detail];
  });
  await provider.onSessionEnd(sessionCtx("two-process"), null, { reason: "completed" });

  // missing template, and pruning never breaks a live session
  await probe("missing-template-throws-not-provisioned-and-live-session-survives", async () => {
    const live = await provider.start(sessionCtx("pruned"), undefined, artifact);
    await live.connection.stop();
    await Snapshot.remove(artifact.snapshot.digest);
    const [missing, detail] = await rejectsWith(
      provider.start(sessionCtx("after-prune"), undefined, artifact),
      SandboxTemplateNotProvisionedError,
    );
    const resumed = await provider.resume(sessionCtx("pruned"), artifact, live.state);
    const bytes = await resumed.readFile({ path: "/workspace/seed.txt" });
    await provider.onSessionEnd(sessionCtx("pruned"), live.state, { reason: "completed" });
    return [missing && bytes !== null && decode(bytes) === "seeded", detail];
  });

  // persistence across a new process: record the stopped bare-open session for phase b
  await (await provider.resume(sessionCtx("bare-open"), artifact, bare.state)).stop();
  writeFileSync(STATE_FILE, JSON.stringify(bare.state));
  record(true, "phase-a-recorded-session-for-new-process");
} else {
  const artifact = JSON.parse(readFileSync("/home/node/artifact.json", "utf8"));
  const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  await probe("new-process-resumes-recorded-session-with-files", async () => {
    const connection = await provider.resume(sessionCtx("bare-open"), artifact, state);
    const bytes = await connection.readFile({ path: "/workspace/kept.txt" });
    return [bytes !== null && decode(bytes) === "kept", bytes === null ? "null" : decode(bytes)];
  });
  await provider.onSessionEnd(sessionCtx("bare-open"), state, { reason: "completed" });
  await probe("cleanup-leaves-no-sandbox", async () => {
    const names = await sandboxNames();
    return [names.length === 0, JSON.stringify(names)];
  });
}

const failed = results.filter((ok) => !ok).length;
console.log(`SUMMARY ${phase}: ${results.length - failed} pass, ${failed} fail`);
process.exit(failed === 0 ? 0 : 1);
