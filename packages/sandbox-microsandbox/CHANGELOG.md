# Changelog

## 0.2.0

Supports eve 0.91.0 as well as 0.83.2; the peer range is `^0.83.2 || ^0.91.0`, and it's built against 0.91.0.

- **An abort reaches the command under either name.** eve 0.84.0 renamed the spawn option `abortSignal` to
  `signal`. 0.1.3 read only `abortSignal`, so under 0.91 an abort no longer killed the command and a cancelled
  command kept running in the VM. `spawn` now reads `signal`, falling back to `abortSignal` for 0.83.
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
