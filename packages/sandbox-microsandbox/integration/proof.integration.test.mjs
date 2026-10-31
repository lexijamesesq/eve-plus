// Real-VM proof for @eve-plus/sandbox-microsandbox. proof.sh runs it inside a throwaway container on a KVM host,
// against the installed package, with a live network. One test per probe, in order: later probes use the template
// and sessions earlier ones made. The last probes record one session, resume it from a new process
// (resume-child.mjs), then clean up.
import { spawn as spawnChild } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SandboxSessionGoneError, SandboxTemplateNotProvisionedError } from "eve/sandbox/provider";
import { Sandbox, Snapshot } from "microsandbox";
import { describe, expect, it } from "vitest";

const pkg = join(process.cwd(), "node_modules/@eve-plus/sandbox-microsandbox/dist");
const { createImplementation, NetworkPolicyConflictError } = await import(
  pathToFileURL(join(pkg, "provider.js")).href
);
const { UnsupportedNetworkPolicyError } = await import(
  pathToFileURL(join(pkg, "network-policy.js")).href
);
const { staleSandboxState } = await import(pathToFileURL(join(pkg, "reap.js")).href);

const ALPINE =
  "alpine:3.22@sha256:2e0b81d60597f449baa56dc25d355367869d2dca4cd57e866f1e2b52af3eb55f";
const ARTIFACT_FILE = "/home/node/artifact.json";
const STATE_FILE = "/home/node/proof-state.json";

// Each probe returns [ok, detail]; the detail is the failure message.
const probe = (name, fn) =>
  it(name, async () => {
    const [ok, detail] = await fn();
    expect(ok, String(detail)).toBe(true);
  });
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
    signal: options.signal,
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
let artifact;
let bare;

describe("prepare", () => {
  probe("prepare-returns-disk-snapshot-artifact", async () => {
    artifact = await provider.prepare(prepareCtx());
    writeFileSync(ARTIFACT_FILE, JSON.stringify(artifact));
    const ok =
      typeof artifact.snapshot?.digest === "string" &&
      typeof artifact.templateKey === "string" &&
      artifact.msbVersion === "0.7.10";
    return [ok, JSON.stringify(artifact)];
  });
  probe("prepare-leaves-no-build-sandbox", async () => {
    const names = await sandboxNames();
    return [!names.some((name) => name.startsWith("eve-plus-tpl-")), JSON.stringify(names)];
  });
  probe("prepare-reuses-cached-template", async () => {
    const again = await provider.prepare(prepareCtx());
    return [again.snapshot.digest === artifact.snapshot.digest, again.snapshot.digest];
  });
  probe("prepare-fails-clearly-without-bash-and-leaves-nothing", async () => {
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
  probe("prepare-failure-in-populate-leaves-nothing", async () => {
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
});

describe("a bare open", () => {
  // A bare open(): eve passes undefined options to start().
  probe("bare-open-config-deny-all-no-tls-no-timeouts-1cpu-1gib", async () => {
    bare = await provider.start(sessionCtx("bare-open"), undefined, artifact);
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
  probe("deny-all-blocks-host", async () => {
    const r = await reaches(bare.connection, "https://example.com");
    return [!r.reached, r.detail];
  });
  probe("deny-all-blocks-direct-ip", async () => {
    const r = await reaches(bare.connection, "-k https://1.1.1.1");
    return [!r.reached, r.detail];
  });
  probe("deny-all-blocks-ipv4-mapped-ipv6", async () => {
    const r = await reaches(bare.connection, "-k -g https://[::ffff:1.1.1.1]");
    return [!r.reached, r.detail];
  });
  probe("deny-all-blocks-outside-dns", async () => {
    const r = await run(bare.connection, "dig +short +time=3 +tries=1 example.com A @1.1.1.1");
    return [!/^\d+\.\d+\.\d+\.\d+/m.test(r.out), r.out || r.err || "no answer"];
  });
  probe("guest-trust-store-is-the-images-own", async () => {
    const r = await run(
      bare.connection,
      "ls /usr/local/share/ca-certificates | wc -l; test -f /etc/ssl/certs/ca-certificates.crt && echo bundle",
    );
    return [r.out.startsWith("0") && r.out.includes("bundle"), r.out];
  });
});

describe("the connection", () => {
  probe("workspace-seeded-from-template", async () => {
    const bytes = await bare.connection.readFile({ path: "/workspace/seed.txt" });
    return [bytes !== null && decode(bytes) === "seeded", bytes === null ? "null" : decode(bytes)];
  });
  probe("spawn-output-exit-cwd-env-agent-marker", async () => {
    const r = await run(bare.connection, 'echo "$PWD $GREETING $AI_AGENT"; echo oops >&2; exit 3', {
      cwd: "/tmp",
      env: { GREETING: "hi" },
    });
    return [r.out === "/tmp hi eve" && r.err === "oops" && r.code === 3, JSON.stringify(r)];
  });
  probe("write-then-read-nested-file", async () => {
    const c = bare.connection;
    await c.writeFiles({ files: [{ path: "/workspace/a/b/c.txt", content: encode("deep") }] });
    const bytes = await c.readFile({ path: "/workspace/a/b/c.txt" });
    return [bytes !== null && decode(bytes) === "deep", bytes === null ? "null" : decode(bytes)];
  });
  probe("read-missing-is-null", async () => {
    const bytes = await bare.connection.readFile({ path: "/workspace/missing.txt" });
    return [bytes === null, String(bytes)];
  });
  probe("read-directory-rejects", async () =>
    rejectsWith(bare.connection.readFile({ path: "/workspace/a" }), Error),
  );
  probe("remove-path-file-force-recursive", async () => {
    const c = bare.connection;
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
  probe("abort-kills-tree-including-background-grandchild", async () => {
    const c = bare.connection;
    const controller = new AbortController();
    const child = await c.spawn({
      signal: controller.signal,
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
});

describe("start: stopped and running sandboxes, concurrency", () => {
  probe("start-reconnects-a-stopped-sandbox-with-its-files", async () => {
    const c = bare.connection;
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
  probe("concurrent-starts-yield-one-sandbox", async () => {
    const opened = await Promise.all(
      Array.from({ length: 4 }, () =>
        provider.start(sessionCtx("concurrent"), undefined, artifact),
      ),
    );
    const names = new Set(opened.map((o) => o.state.sandboxName));
    const count = (await sandboxNames()).filter((name) => names.has(name)).length;
    return [names.size === 1 && count === 1, `${names.size} name(s), ${count} sandbox(es)`];
  });
  probe("two-process-starts-yield-one-sandbox", async () => {
    const [one, two] = await Promise.all([
      runChild(["integration/start-child.mjs", "two-process"]),
      runChild(["integration/start-child.mjs", "two-process"]),
    ]);
    const lines = [one, two].map((r) => r.out.split("\n").at(-1));
    const count = (await sandboxNames()).filter((name) => name === lines[0]).length;
    const ok = one.code === 0 && two.code === 0 && lines[0] === lines[1] && count === 1;
    return [ok, `exit ${one.code}/${two.code}; ${lines.join(" ")}; ${count} sandbox(es)`];
  });
  probe("deny-all-open-of-an-allow-all-sandbox-is-refused", async () => {
    const conflictCtx = sessionCtx("policy-conflict");
    const open = await provider.start(conflictCtx, { networkPolicy: "allow-all" }, artifact);
    const [refused, detail] = await rejectsWith(
      provider.start(conflictCtx, undefined, artifact),
      NetworkPolicyConflictError,
    );
    await provider.onSessionEnd(conflictCtx, open.state, { reason: "completed" });
    return [refused, detail];
  });
});

describe("network policies", () => {
  probe("allow-all-reaches-host", async () => {
    const open = await provider.start(
      sessionCtx("allow-all"),
      { networkPolicy: "allow-all" },
      artifact,
    );
    const r = await reaches(open.connection, "https://example.com");
    await provider.onSessionEnd(sessionCtx("allow-all"), open.state, { reason: "completed" });
    return [r.reached, r.detail];
  });
  // Every unsupported shape fails the same check before any VM call, so one stands for all of them.
  probe("rejects-an-unsupported-policy-creating-nothing", async () => {
    const before = await sandboxNames();
    const [rejected, detail] = await rejectsWith(
      provider.start(sessionCtx("rejected"), { networkPolicy: {} }, artifact),
      UnsupportedNetworkPolicyError,
    );
    const after = await sandboxNames();
    return [rejected && before.length === after.length, detail];
  });
});

describe("the public profile", () => {
  let open;
  probe("public-reaches-a-public-host-by-name", async () => {
    open = await provider.start(sessionCtx("public"), { networkPolicy: "public" }, artifact);
    const r = await reaches(open.connection, "https://registry.npmjs.org/eve");
    return [r.reached, r.detail];
  });
  // A server in this process is the VM's host. allow-all reaching it shows the probe can fail.
  probe("public-blocks-the-host-that-allow-all-reaches", async () => {
    const server = createServer((_, response) => response.end("from-host")).listen(0, "0.0.0.0");
    await new Promise((resolve) => server.once("listening", resolve));
    const url = `http://host.microsandbox.internal:${server.address().port}`;
    const control = await provider.start(
      sessionCtx("host-control"),
      { networkPolicy: "allow-all" },
      artifact,
    );
    const fromAllowAll = await run(control.connection, `curl -s --max-time 5 ${url}`);
    const fromPublic = await run(open.connection, `curl -s --max-time 5 ${url}`);
    await provider.onSessionEnd(sessionCtx("host-control"), control.state, { reason: "completed" });
    server.close();
    const ok = fromAllowAll.out === "from-host" && fromPublic.out !== "from-host";
    return [ok, JSON.stringify({ fromAllowAll, fromPublic })];
  });
  probe("deny-all-open-of-a-public-sandbox-is-refused", async () => {
    const [refused, detail] = await rejectsWith(
      provider.start(sessionCtx("public"), undefined, artifact),
      NetworkPolicyConflictError,
    );
    await provider.onSessionEnd(sessionCtx("public"), open.state, { reason: "completed" });
    return [refused, detail];
  });
});

describe("the disk and time limits", () => {
  const limited = createImplementation({
    rootDiskMib: 1024,
    maxDurationSecs: 20,
    idleTimeoutSecs: 600,
  });
  let limitedArtifact;
  let open;
  probe("root-disk-cap-holds-in-a-restored-vm", async () => {
    limitedArtifact = await limited.prepare(prepareCtx({ salt: "limits" }));
    open = await limited.start(sessionCtx("limits"), undefined, limitedArtifact);
    const r = await run(
      open.connection,
      "dd if=/dev/zero of=/workspace/fill bs=1M count=2000 2>/dev/null; echo $?; " +
        "df -m / | awk 'NR==2{print $2}'; rm -f /workspace/fill",
    );
    const [exit, size] = r.out.split("\n");
    // The uncapped template's VM is the control: without the cap the disk is larger, so the probe can fail.
    const uncapped = await run(bare.connection, "df -m / | awk 'NR==2{print $2}'");
    const ok = exit !== "0" && Number(size) <= 1024 && Number(uncapped.out) > 1024;
    return [ok, JSON.stringify({ capped: r.out, uncapped: uncapped.out })];
  });
  probe("time-limits-are-recorded-on-the-session-vm", async () => {
    const { lifecycle } = JSON.parse((await Sandbox.get(open.state.sandboxName)).configJson);
    const ok = lifecycle.max_duration_secs === 20 && lifecycle.idle_timeout_secs === 600;
    return [ok, JSON.stringify(lifecycle)];
  });
  probe("max-duration-stops-the-vm-and-the-next-start-boots-it-with-its-files", async () => {
    // The limit stops the VM hard, so the file is synced first; what isn't synced can be lost.
    await run(open.connection, "printf kept > /workspace/kept.txt && sync");
    await new Promise((resolve) => setTimeout(resolve, 35_000));
    const status = (await Sandbox.get(open.state.sandboxName)).status;
    const again = await limited.start(sessionCtx("limits"), undefined, limitedArtifact);
    const bytes = await again.connection.readFile({ path: "/workspace/kept.txt" });
    await limited.onSessionEnd(sessionCtx("limits"), open.state, { reason: "completed" });
    await Snapshot.remove(limitedArtifact.snapshot.digest);
    const ok = status === "stopped" && bytes !== null && decode(bytes) === "kept";
    return [ok, JSON.stringify({ status, kept: bytes === null ? null : decode(bytes) })];
  });
});

describe("reaping", () => {
  // Stopped is how a stranded session's VM is left; running is a live one mid-command.
  probe("a-stopped-vm-is-reaped-and-a-running-one-survives", async () => {
    const stranded = await provider.start(sessionCtx("reap-stranded"), undefined, artifact);
    const live = await provider.start(sessionCtx("reap-live"), undefined, artifact);
    await stranded.connection.stop();
    const ours = [stranded.state.sandboxName, live.state.sandboxName];
    const stale = (await staleSandboxState({ unusedForMs: 0, now: Date.now() + 60_000 })).filter(
      (item) => ours.includes(item.name),
    );
    for (const item of stale) await item.remove();
    const left = (await sandboxNames()).filter((name) => ours.includes(name));
    await provider.onSessionEnd(sessionCtx("reap-live"), live.state, { reason: "completed" });
    const ok =
      stale.length === 1 &&
      stale[0].name === stranded.state.sandboxName &&
      left.length === 1 &&
      left[0] === live.state.sandboxName;
    return [ok, JSON.stringify({ stale: stale.map((item) => item.name), left })];
  });
});

describe("a stale runtime: an older msb selected through MSB_PATH, then one sitting in MSB_HOME", () => {
  probe("stale-runtime-via-msb-path-is-refused", async () => {
    const r = await runChild(["integration/stale-child.mjs"], {
      MSB_PATH: "/home/node/stale/package/bin/msb",
      MSB_LIBKRUNFW_PATH: "/home/node/stale/package/lib/libkrunfw.so.5.6.1",
    });
    return [r.out.includes("refused MicrosandboxRuntimeMismatchError"), r.out];
  });
  probe("stale-runtime-in-msb-home-never-runs", async () => {
    // The child's MSB_HOME holds the stale pair and no template. Either microsandbox prefers the
    // locked package (then start gets as far as the missing template), or the provider refuses.
    const r = await runChild(["integration/stale-child.mjs"], {
      MSB_HOME: "/home/node/stale-home",
    });
    const lockedWins =
      r.out.includes("resolved sdk_package 0.7.10") &&
      r.out.includes("refused SandboxTemplateNotProvisionedError");
    const refused = r.out.includes("refused MicrosandboxRuntimeMismatchError");
    return [lockedWins || refused, r.out];
  });
});

describe("ending sessions, and a missing template", () => {
  probe("session-end-deletes-idempotently-then-resume-is-gone", async () => {
    const ctx = sessionCtx("concurrent");
    const state = (await provider.start(ctx, undefined, artifact)).state;
    await provider.onSessionEnd(ctx, state, { reason: "completed" });
    await provider.onSessionEnd(ctx, state, { reason: "completed" });
    await provider.onSessionEnd(sessionCtx("never-existed"), null, { reason: "deleted" });
    await provider.onSessionEnd(sessionCtx("two-process"), null, { reason: "completed" });
    const [gone, detail] = await rejectsWith(
      provider.resume(ctx, artifact, state),
      SandboxSessionGoneError,
    );
    return [gone, detail];
  });
  // Pruning a template never breaks a live session.
  probe("missing-template-throws-not-provisioned-and-live-session-survives", async () => {
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
});

describe("persistence across a new process", () => {
  probe("new-process-resumes-recorded-session-with-files", async () => {
    await (await provider.resume(sessionCtx("bare-open"), artifact, bare.state)).stop();
    writeFileSync(STATE_FILE, JSON.stringify(bare.state));
    const r = await runChild(["integration/resume-child.mjs"]);
    return [r.code === 0 && r.out.split("\n").at(-1) === "kept", r.out];
  });
  probe("cleanup-leaves-no-sandbox", async () => {
    await provider.onSessionEnd(sessionCtx("bare-open"), bare.state, { reason: "completed" });
    const names = await sandboxNames();
    return [names.length === 0, JSON.stringify(names)];
  });
});
