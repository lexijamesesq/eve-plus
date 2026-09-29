---
tags:
  - type/claude-repo
description: "{What this repo is and what it builds — one or two sentences.}"
docs_home: "{workspace_root}/{path to the paired vault knowledge-home folder} — the {workspace_root} placeholder form, not a literal expanded path (a git-tracked file encoding the operator's real local vault path trips the operator-infra-path gitleaks rule, in any repo regardless of visibility). Omit only if this repo genuinely has no vault knowledge home."
---

# {Repo Name}

{One paragraph: what this repo is, what it builds/ships, who/what consumes it. A session, engine, or CI runner with zero other context should understand the repo's purpose from this paragraph alone.}

## Setup

{How to get from a fresh clone to a working local environment — install steps, dependencies, required tools. Copy any `*.sample.*`/`*.example.*` config files to their real names and fill in values (see Configuration below).}

## Configuration

{Config keys skills/code read at runtime, by key name — not hardcoded. Sensitive values referenced by path (1Password, env var), never inlined. Mirrors the `*.sample.*` files this repo ships for consumers.}

```yaml
# example
some.config.key: "value or op://vault/item/field reference"
```

## Build / Test

{Exact commands to build and run the test suite locally. If there's more than one (lint, unit, integration), name each and what it checks.}

## CI

{What runs on every PR, what's required to merge, where the workflow/ruleset config lives. Point at `.github/workflows/` rather than duplicating the YAML — this section names the shape (checks, required-status gate), not the implementation.}

## Conventions

{Code style, commit message shape, branch naming, anything a contributor or an autonomous session would get wrong by guessing. Only what's genuinely non-obvious — skip anything a linter already enforces.}

## Workflow Cadence

{Recurring operational rhythms, if this repo has any — e.g. "run `/skill-name` monthly," a deploy cadence, a scheduled job. Omit entirely if the repo has none (most don't).}

## Key Files

{Only files a session can't discover from the filesystem — non-obvious paths, entry points, generated files that shouldn't be hand-edited.}

| File | Purpose |
| ---- | ------- |
