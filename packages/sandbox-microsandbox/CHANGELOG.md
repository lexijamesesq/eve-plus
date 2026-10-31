# Changelog

## 0.3.0

- **A `public` network policy.** `open({ networkPolicy: "public" })` creates the VM under microsandbox's own `public`
  profile: public internet and DNS, with private, loopback, link-local, metadata and host addresses denied. A
  stricter later `open()` on that sandbox is refused, as `deny-all` on an `allow-all` sandbox already was.
- **Disk and time limits.** `rootDiskMib` sets the root disk at template build and joins the template key when set,
  so templates built without it keep their key. `maxDurationSecs` and `idleTimeoutSecs` pass to every session VM's
  restore. Either limit stops the VM; the next access boots it again.
- **Reaping.** `staleSandboxState({ unusedForMs })` finds this provider's VMs that are stopped and unused since the
  cutoff, and templates past it that aren't among the two newest, each with a `remove()`. It's for a periodic job:
  sessions stranded by an eve upgrade never run `onSessionEnd`, and old templates were never removed.
- The real-VM proof adds probes for each: `public` reaches a public host by name and is refused by a host server
  that an `allow-all` VM reaches; a 1 GiB disk can't be filled past its size in a restored VM; the time limits are
  recorded on the session VM, and a stopped VM boots again with its synced files; a stopped VM is reaped and a
  running one survives.

No state or naming change: sessions recorded by 0.2.0 resume, and environments that set none of the new options
build the same template.

## 0.2.1

Tests only: the real-VM proof's steps inside the container move from `integration/run.sh` to `integration/proof.sh`,
which builds the package from the checkout under test and installs the eve, `ai` and vitest versions its own
`devDependencies` name, so the proof always tests the version it's run at. `run.sh` is gone: the container, its posture
and its limits belong to whoever runs the proof. No change to shipped code.

## 0.2.0

Built and tested against eve 0.91.0; the peer range is `^0.91.0`. eve 0.83 is no longer supported: an agent takes
0.2.0 in the same change that takes it to eve 0.91.0.

- **An abort reaches the command again.** eve 0.84.0 renamed the spawn option `abortSignal` to `signal`. 0.1.3
  read only `abortSignal`, so under 0.91 an abort no longer killed the command and a cancelled command kept running
  in the VM. `spawn` now reads `signal`.
- **A failed kill stays quiet under 0.91's types.** 0.91 types a process's `kill()` as `PromiseLike`; the abort
  handler wraps it in a promise before swallowing its failure.
- The real-VM proof installs eve 0.91.0 and passes `signal`.

A `stdin: true` spawn, new in eve 0.84.1, isn't supported: eve 0.91 kills the process and rejects the call, as its
provider contract says. No state or naming change: sessions recorded by 0.1.x resume.

## 0.1.3

Documents that a consumer must keep the package external in `eve build` (`build.externalDependencies`). No code
change.

## 0.1.2

Documentation only: the README no longer says the unit tests run in CI, since the hosted test workflow was retired.
No code change.

## 0.1.1

Tests only: the unit tests are tightened to the behaviour they protect, and the real-VM proof runs as one vitest test
per probe. No change to shipped code.

## 0.1.0

First release: one microsandbox microVM per session, deny-all by default, on eve's public sandbox provider seam.
