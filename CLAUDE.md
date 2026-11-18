---
tags:
  - type/claude-repo
description: "A kit of packages that extend Vercel's self-hosted eve agent runtime: memory, working memory, a microsandbox sandbox provider and commissioning."
linear_project_id: "934bfa7a-8ed1-4838-9347-2cf5bada3539"
linear_url: "https://linear.app/lexijamesesq/project/agents-7f8b1979db6e"
notion_project: "https://app.notion.com/p/4185f53f7dbc81c59bd6f6de24a314cb"
notion_knowledge: "collection://4185f53f-7dbc-8191-8727-000b55ab0c71"
---

# eve-plus

A pnpm workspace of four packages that add to a self-hosted eve agent what eve does not ship. Each is built on eve's public extension points and is installed by an agent project from a release tag in this repository. Nothing here is specific to one deployment.

| Package | What it is |
| ------- | ---------- |
| `@eve-plus/memory` | A memory provider: an ontology over an embedded SQLite graph that the agent shapes and validates itself. |
| `@eve-plus/working` | A working-memory provider: open loops, standing orders and notes, in front of the agent every turn. |
| `@eve-plus/sandbox-microsandbox` | A sandbox provider: one microVM per session, deny-all by default. |
| `@eve-plus/commissioning` | Lets an agent hand software work to a worker, answer its questions and decide its proposals. Ships a Cyrus connector. |

The maintainer's project documentation is in Notion and its work is tracked in Linear; the front matter above points to both. They are private: a consumer of these packages has no access to them and does not need it.

## Intent

### Objective

Give a self-hosted eve agent memory, working memory, an isolated sandbox and a way to commission work, as packages that read like something eve's own maintainers could have shipped.

### Health Metrics

- Every package installs and resolves as a consumer installs it on the eve version pinned for development.
- A package uses eve's public extension points only: no sidecar, no patch to eve's internals.
- The repository holds nothing specific to any one deployment.

### Decision Authority

- **A session may:** change a package, its tests and its documentation, and raise its version, through a pull request.
- **Needs the maintainer:** widening or narrowing a package's supported eve range, a new package, a breaking change to a package's public surface.

### Stop Rules

- Stop if a change needs something eve does not expose. That is a finding to raise, not a gap to bridge.
- Stop before adding anything that describes a particular deployment: hosts, agents, credentials or topology.

## Setup

Node 24 and pnpm (the version is pinned in the root `package.json`).

```bash
pnpm install
```

## Build / Test

```bash
pnpm run build       # builds every package
pnpm run typecheck   # type-checks every package
pnpm run test        # each package's tests; memory, working and commissioning run unit then integration
```

There is no lint script. Linting and formatting run through the pre-commit hooks (Biome, ruff, shellcheck, shfmt, yamllint, markdownlint, actionlint, zizmor, gitleaks). `@eve-plus/memory` also has `pnpm run mutate` for its mutation run.

The sandbox package's real-VM proof, `packages/sandbox-microsandbox/integration/proof.sh`, needs a host with microsandbox and does not run in this repository's CI.

## CI

`.github/workflows/ci.yml` is the only workflow.

- On a pull request it calls the shared estate workflow, then, for a change classified as functional, runs package validation: `.github/scripts/check-consumer-install.sh` installs each package from GitHub the way a consumer does and resolves every export, and `.github/scripts/check-consumer-matrix.sh` installs all four packages into one agent on the pinned stable eve version and compiles it.
- On a push to `main` it tags releases (below).

CI does not run `pnpm run test`; run it locally before pushing.

## Conventions

- **A release is a version bump.** Raise `version` in the package's `package.json` in the same pull request as the change. On merge, CI cuts the tag `<package>--v<version>` and a GitHub Release for any version not yet tagged. Never tag by hand. A pre-push hook checks each package's version.
- **Packages are installed by tag, not from npm:** `github:lexijamesesq/eve-plus#<package>--v<version>&path:packages/<package>`.
- **Stable eve compatibility.** All four packages declare `~1.0.1` and pin development eve to `1.0.1`. The peer range admits later 1.0 patches. The consumer check exercises the exact pinned version. Review and test a patch before adopting it. A compatible patch in the existing range needs no package release. Changing the supported range requires the maintainer’s decision.
- `@eve-plus/commissioning` builds with `eve extension build` on eve 1.0.1, the lowest version the peer range admits. eve refuses an extension built by a newer version than the running eve. Keep the build pin at the floor while that floor is supported.

## Key Files

| File | Purpose |
| ---- | ------- |
| `.github/scripts/check-consumer-matrix.sh` | Installs from Git with strict peers and compiles a consumer on eve 1.0.1 |
| `.github/scripts/tag-package-release.sh` | Cuts a package's release tag from its version on merge |
| `research/` | Investigation records behind package design choices |
