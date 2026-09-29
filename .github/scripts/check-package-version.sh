#!/usr/bin/env bash
# check-package-version.sh <package_dir> <package_name>
#
# PR-time check (no writes). Compares the package's tree against its highest
# existing `<package_name>--v*` tag, not the tag matching the declared version,
# so the check stays live even if the push-time tagger is behind (a
# merged-but-untagged version still trips a later mismatch instead of a free
# pass).
#
# No existing tag => nothing to compare yet => pass (day one / new package).
# Tree identical to the tag => pass.
# Tree changed and the declared version isn't above the tag's => fail loud.
set -euo pipefail

PACKAGE_DIR="$1"
PACKAGE_NAME="$2"

LATEST_TAG="$(git tag -l "${PACKAGE_NAME}--v*" --sort=-v:refname | head -1)"

if [[ -z "$LATEST_TAG" ]]; then
	echo "PASS $PACKAGE_NAME: no existing tag, nothing to compare yet"
	exit 0
fi

TAG_VERSION="${LATEST_TAG#"${PACKAGE_NAME}--v"}"
# package.json comes from the PR branch. PACKAGE_DIR (a workflow-controlled
# literal) goes in as argv and the version is read through json, never
# interpolated into a -c source. The version string itself is untrusted PR
# content; it's compared below via os.environ, never interpolated into script
# text.
CURRENT_VERSION="$(python3 -c "
import json, sys
print(json.load(open(sys.argv[1] + '/package.json'))['version'])
" "$PACKAGE_DIR")"

# Repo-level infrastructure (CI and lint config, release tooling,
# dependency-bot config) is never package content. These excludes are no-ops
# while PACKAGE_DIR is a subdirectory; they matter if a package ever sits at
# the repo root, where they'd otherwise fail every CI-only change.
if git diff --quiet "$LATEST_TAG" HEAD -- "$PACKAGE_DIR" \
	":(exclude)${PACKAGE_DIR%/}/.pre-commit-config.yaml" \
	":(exclude)${PACKAGE_DIR%/}/.yamllint.yaml" \
	":(exclude)${PACKAGE_DIR%/}/.markdownlint.yaml" \
	":(exclude)${PACKAGE_DIR%/}/ruff.toml" \
	":(exclude)${PACKAGE_DIR%/}/biome.json" \
	":(exclude)${PACKAGE_DIR%/}/renovate.json" \
	":(exclude)${PACKAGE_DIR%/}/.github"; then
	echo "PASS $PACKAGE_NAME: tree identical to $LATEST_TAG"
	exit 0
fi

VERSION_BUMPED="$(CURRENT_VERSION="$CURRENT_VERSION" TAG_VERSION="$TAG_VERSION" python3 -c "
import os

def parse(v):
    return tuple(int(x) for x in v.split('.'))

current = parse(os.environ['CURRENT_VERSION'])
tag = parse(os.environ['TAG_VERSION'])
print('1' if current > tag else '0')
")"

if [[ "$VERSION_BUMPED" == "1" ]]; then
	echo "PASS $PACKAGE_NAME: tree changed, version bumped $TAG_VERSION -> $CURRENT_VERSION"
	exit 0
fi

echo "FAIL $PACKAGE_NAME: package content changed without a version bump (still $CURRENT_VERSION, last tag $LATEST_TAG)"
exit 1
