import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const worker = join(repo, "packages/commissioning");

test("tagged worker assets recover on later main, stay immutable, and refuse a losing tag source", {
  timeout: 60000,
}, () => {
  const root = mkdtempSync(join(tmpdir(), "commissioning-release-fixture-"));
  try {
    const source = join(root, "source");
    const bin = join(root, "bin");
    const remote = join(root, "origin.git");
    const assets = join(root, "remote-assets");
    const bundle = join(root, "bundle");
    for (const path of [source, bin, assets, bundle, join(root, "home"), join(root, "template")])
      mkdirSync(path);
    // All Git routing is fixture-owned, including template and global/system configuration.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
    );
    Object.assign(env, {
      HOME: join(root, "home"),
      TMPDIR: root,
      RUNNER_TEMP: root,
      PATH: `${bin}:${process.env.PATH}`,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TEMPLATE_DIR: join(root, "template"),
      RELEASE_FIXTURE_ROOT: root,
      RELEASE_FIXTURE_BUNDLE: bundle,
    });
    function command(program, args, cwd = source, expected = 0) {
      const result = spawnSync(program, args, { cwd, env, encoding: "utf8" });
      assert.equal(
        result.status,
        expected,
        `${program} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`,
      );
      return result.stdout.trim();
    }
    const archive =
      process.env.WORKER_TEST_ARTIFACT_DIR &&
      join(
        process.env.WORKER_TEST_ARTIFACT_DIR,
        `commissioning-worker-v${JSON.parse(readFileSync(join(worker, "package.json"))).version}.tar.gz`,
      );
    if (archive) command("tar", ["-xzf", resolve(archive), "-C", bundle]);
    else
      for (const name of ["index.js", "licenses.txt"])
        cpSync(join(worker, ".worker-build", name), join(bundle, name));
    assert.ok(
      existsSync(join(bundle, "index.js")),
      "Build the actual worker before testing its publisher",
    );
    const packageDir = join(source, "packages/commissioning");
    mkdirSync(join(packageDir, "tests"), { recursive: true });
    mkdirSync(join(source, ".github/scripts"), { recursive: true });
    cpSync(join(repo, "LICENSE"), join(source, "LICENSE"));
    cpSync(
      join(worker, "tests/public-consumer.mjs"),
      join(packageDir, "tests/public-consumer.mjs"),
    );
    for (const name of ["tag-package-release.sh", "build-worker-release.sh"])
      cpSync(join(repo, ".github/scripts", name), join(source, ".github/scripts", name));
    writeFileSync(
      join(packageDir, "package.json"),
      JSON.stringify({ name: "@eve-plus/commissioning", version: "1.2.3" }),
    );
    writeFileSync(
      join(bin, "pnpm"),
      `#!${process.execPath}\nconst fs=require('node:fs'),p=require('node:path');const a=process.argv.slice(2),dir=a[a.indexOf('--dir')+1];if(a.includes('build:worker')){const out=p.join(dir,'.worker-build');fs.mkdirSync(out,{recursive:true});for(const n of ['index.js','licenses.txt'])fs.copyFileSync(p.join(process.env.RELEASE_FIXTURE_BUNDLE,n),p.join(out,n));}\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(bin, "gh"),
      `#!${process.execPath}
const fs=require('node:fs'),p=require('node:path'),r=process.env.RELEASE_FIXTURE_ROOT,state=p.join(r,'release.json'),dest=p.join(r,'remote-assets');
const a=process.argv.slice(2),s=fs.existsSync(state)?JSON.parse(fs.readFileSync(state)):null;
if(a[0]!=='release')process.exit(2);
if(a[1]==='view'){if(!s)process.exit(1);if(a.includes('--json'))console.log(fs.readdirSync(dest).join('\\n'));}
else if(a[1]==='create'){if(s)process.exit(1);fs.writeFileSync(state,JSON.stringify({tag:a[2]}));for(const f of a.slice(3))if(fs.existsSync(f)&&fs.statSync(f).isFile())fs.copyFileSync(f,p.join(dest,p.basename(f)));}
else if(a[1]==='upload'){const f=a[3],to=p.join(dest,p.basename(f));if(fs.existsSync(to))process.exit(1);fs.copyFileSync(f,to);}
else if(a[1]==='download'){const name=a[a.indexOf('--pattern')+1],to=a[a.indexOf('--dir')+1];if(!fs.existsSync(p.join(dest,name)))process.exit(1);fs.copyFileSync(p.join(dest,name),p.join(to,name));}
else process.exit(2);
`,
      { mode: 0o755 },
    );
    command("git", ["init", "--bare", remote]);
    command("git", ["init"]);
    command("git", ["config", "user.name", "Release Fixture"]);
    command("git", ["config", "user.email", "fixture@example.invalid"]);
    command("git", ["add", "."]);
    command("git", ["commit", "-m", "initial fixture"]);
    command("git", ["remote", "add", "origin", remote]);
    const first = command("git", ["rev-parse", "HEAD"]);
    const publish = () =>
      command("bash", [
        ".github/scripts/tag-package-release.sh",
        "packages/commissioning",
        "commissioning",
      ]);
    publish();
    const name = "commissioning-worker-v1.2.3.tar.gz";
    const original = readFileSync(join(assets, name));
    const manifest = JSON.parse(command("tar", ["-xOf", join(assets, name), "package.json"]));
    assert.equal(manifest.gitHead, first);
    // A later main commit must recover only the missing asset from the immutable tag's source.
    writeFileSync(join(source, "later-main"), "different source tree");
    command("git", ["add", "."]);
    command("git", ["commit", "-m", "later main"]);
    rmSync(join(assets, `${name}.sha256`));
    publish();
    assert.deepEqual(readFileSync(join(assets, name)), original);
    assert.ok(existsSync(join(assets, `${name}.sha256`)));
    // Existing remote bytes are immutable even when they conflict with the authoritative build.
    writeFileSync(join(assets, name), "conflicting published bytes");
    const conflict = spawnSync(
      "bash",
      [".github/scripts/tag-package-release.sh", "packages/commissioning", "commissioning"],
      { cwd: source, env, encoding: "utf8" },
    );
    assert.notEqual(conflict.status, 0);
    assert.equal(readFileSync(join(assets, name), "utf8"), "conflicting published bytes");
    // Simulate a concurrent tag winner during the external build, before this publisher pushes.
    rmSync(join(root, "release.json"));
    for (const file of [name, `${name}.sha256`]) rmSync(join(assets, file));
    const tag = "commissioning--v1.2.3";
    command("git", ["tag", "-d", tag]);
    command("git", ["push", "origin", `:refs/tags/${tag}`]);
    const winner = first;
    writeFileSync(
      join(bin, "pnpm"),
      readFileSync(join(bin, "pnpm"), "utf8") +
        `\nif(a.includes('build:worker')){require('node:child_process').execFileSync('git',['--git-dir',${JSON.stringify(remote)},'-c','user.name=Other publisher','-c','user.email=other@example.invalid','tag','-a',${JSON.stringify(tag)},${JSON.stringify(winner)},'-m','concurrent winner']);}\n`,
    );
    const race = spawnSync(
      "bash",
      [".github/scripts/tag-package-release.sh", "packages/commissioning", "commissioning"],
      { cwd: source, env, encoding: "utf8" },
    );
    assert.notEqual(race.status, 0);
    assert.equal(existsSync(join(root, "release.json")), false);
    assert.equal(existsSync(join(assets, name)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
