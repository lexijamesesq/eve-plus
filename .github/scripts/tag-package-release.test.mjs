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
    const env = {
      HOME: join(root, "home"),
      TMPDIR: root,
      RUNNER_TEMP: root,
      PATH: `${bin}:${process.env.PATH}`,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TEMPLATE_DIR: join(root, "template"),
      RELEASE_FIXTURE_ROOT: root,
      RELEASE_FIXTURE_BUNDLE: bundle,
      GH_TOKEN: "synthetic-publisher-token",
      GITHUB_TOKEN: "synthetic-publisher-token",
    };
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
      `#!${process.execPath}\nconst fs=require('node:fs'),p=require('node:path');const a=process.argv.slice(2),dir=a[a.indexOf('--dir')+1];if(process.env.GH_TOKEN||process.env.GITHUB_TOKEN)throw new Error('Build received publishing credentials');if(fs.existsSync(p.join(process.env.RELEASE_FIXTURE_ROOT,'fail-build')))throw new Error('Completed release must not rebuild');if(a.includes('build:worker')){const out=p.join(dir,'.worker-build');fs.mkdirSync(out,{recursive:true});for(const n of ['index.js','licenses.txt'])fs.copyFileSync(p.join(process.env.RELEASE_FIXTURE_BUNDLE,n),p.join(out,n));fs.writeFileSync(p.join(process.env.RELEASE_FIXTURE_ROOT,'build-completed'),'ready');}\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(bin, "gh"),
      `#!${process.execPath}
const fs=require('node:fs'),p=require('node:path'),r=process.env.RELEASE_FIXTURE_ROOT,state=p.join(r,'release.json'),dest=p.join(r,'remote-assets');
const a=process.argv.slice(2),s=fs.existsSync(state)?JSON.parse(fs.readFileSync(state)):null;
if(a[0]!=='release')process.exit(2);
if(a[1]==='view'){if(!s)process.exit(1);if(a.includes('--json')){const names=fs.readdirSync(dest);if(fs.existsSync(p.join(r,'publish-on-view'))&&fs.existsSync(p.join(r,'build-completed'))){fs.writeFileSync(p.join(dest,'commissioning-worker-v1.2.3.tar.gz'),'concurrent published bytes');fs.unlinkSync(p.join(r,'publish-on-view'));}console.log(names.join('\\n'));}}
else if(a[1]==='create'){if(s)process.exit(1);fs.writeFileSync(state,JSON.stringify({tag:a[2]}));for(const f of a.slice(3))if(fs.existsSync(f)&&fs.statSync(f).isFile())fs.copyFileSync(f,p.join(dest,p.basename(f)));}
else if(a[1]==='upload'){const f=a.slice(2).find(v=>fs.existsSync(v)&&fs.statSync(v).isFile());if(!f)process.exit(2);const to=p.join(dest,p.basename(f));if(fs.existsSync(to)&&!a.includes('--clobber'))process.exit(1);fs.copyFileSync(f,to);}
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
    // A complete release validates its published pair without starting the external toolchain.
    writeFileSync(join(root, "fail-build"), "must stay cold");
    publish();
    rmSync(join(root, "fail-build"));
    // Publish conflicting bytes after the absence check and before upload, as another publisher can.
    rmSync(join(assets, name));
    rmSync(join(root, "build-completed"));
    writeFileSync(join(root, "publish-on-view"), "race");
    const assetRace = spawnSync(
      "bash",
      [".github/scripts/tag-package-release.sh", "packages/commissioning", "commissioning"],
      { cwd: source, env, encoding: "utf8" },
    );
    assert.ok(
      readFileSync(join(assets, name)).equals(Buffer.from("concurrent published bytes")),
      "Concurrent published bytes must remain unchanged",
    );
    assert.notEqual(assetRace.status, 0);
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
