---
tags:
  - type/claude-repo
description: "Public, reusable providers and extensions for Vercel's self-hosted eve runtime."
---

# eve-plus

Eve-plus extends published [eve](https://github.com/vercel/eve) through its public provider and extension APIs. This pnpm monorepo contains [memory](packages/memory/README.md), [microsandbox](packages/sandbox-microsandbox/README.md), and [commissioning](packages/commissioning/README.md) packages. Each package is independently versioned and usable by applications outside this repository.

## Setup

Use Node 24, matching CI and package runtime requirements. The root `packageManager` pins pnpm 12.4.2:

```sh
pnpm install --frozen-lockfile
```

The workspace permits the `better-sqlite3` install script so the native binding can be installed for the current platform. Follow each package's README for its runtime prerequisites. Package tests use isolated fixtures; production credentials are not needed for routine checks.

## Build and test

Run checks for the affected package:

```sh
pnpm --filter @eve-plus/commissioning run typecheck
pnpm --filter @eve-plus/commissioning test
pnpm --filter @eve-plus/commissioning run build
```

Substitute the relevant package name for memory or microsandbox. Root `pnpm run typecheck`, `pnpm test`, and `pnpm run build` run the corresponding scripts across the workspace when shared changes require them. Existing tests use Vitest. Keep regression coverage focused on observable behavior and include a meaningful failure control.

Commissioning's [validation guide](packages/commissioning/docs/validation.md) distinguishes source tests, packed-consumer checks, and explicit native runtime probes. An import or build result does not establish runtime behavior. Generated `dist/` and consumer output are build artifacts, not source changes.

## Configuration and design

Each package's README documents its configuration and public exports. Applications supply their own identities, credentials, routes, storage locations and deployment policy. Keep application-specific configuration and operational details out of these public packages.

Use published eve dependencies and supported seams. Match eve's own provider, extension, tool and build conventions. Prefer existing tools and established patterns; do not patch eve internals or add a sidecar to simulate a missing extension point. Examples must work for an independent consumer and use synthetic values where credentials are required.

## Local checks and CI

Use the existing native Git hooks and `.pre-commit-config.yaml`; preserve their owner and do not bypass scanners or checks. Pre-commit owns formatting and static checks, commit-message scanning runs at commit, and pre-push owns outgoing-history scanning and package-version checks. Missing hook prerequisites must be resolved before claiming those checks passed.

[CI](.github/workflows/ci.yml) calls the shared estate PR workflow for trusted scanning, classification and review handoff. The required check contexts are `Shared / Pre-Merge Checks` and `Package Validation`. The existing hosted package job runs only for functional changes, validates the authenticated head before checkout, and retains the read-only cache guard. It checks Git-consumer installation/exports for every package, including commissioning. Source behavior, typechecks and packed-consumer qualification run locally through the package commands above; do not add module-specific hosted suites. Mechanical and documentation changes use the native skip path. Do not introduce a second classifier or run PR code in the trusted producer job.

Use the [PR template](.github/pull_request_template.md), identifying the exact candidate and checks actually completed. Local checks and earlier CI runs do not certify a different pushed head.

## Releases

Packages are consumed from Git release tags using `github:lexijamesesq/eve-plus#<package>--v<version>&path:packages/<package>`. A Git consumer runs the package's `prepare` build; preserve the documented exports and package file list.

On a push to `main`, the existing release job calls [tag-package-release.sh](.github/scripts/tag-package-release.sh) for each package, creating its annotated `<package>--v<version>` tag and GitHub Release when missing. Keep independent package versions and changelogs current. Native pre-push version checks compare outgoing package content with remote release tags through [check-package-version.sh](.github/scripts/check-package-version.sh). Do not hand-tag, add a parallel publisher, or claim an unreleased tag is available.

Application deployment belongs to the consuming application. This repository releases reusable packages; it does not deploy an agent fleet.
