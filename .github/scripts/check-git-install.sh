#!/usr/bin/env bash
# check-git-install.sh <package_dir> [rev]
#
# PR-time check (no writes outside a temp directory). Installs the package the way a git consumer does: the
# package's tree at <rev> (default HEAD) alone in a fresh directory, then `npm install`, which runs its `prepare`
# build. A consumer's pnpm or npm does exactly this for a `github:` dependency, and npm is stricter than this repo's
# own pnpm install: a peer conflict among the package's devDependencies fails here (ERESOLVE) while the suite stays
# green. 0.2.0 shipped that way.
#
# Fails on any install or build error, or if the entry point the package exports wasn't built.
set -euo pipefail

PACKAGE_DIR="$1"
REV="${2:-HEAD}"

WORK="$(mktemp -d)"
git archive "$REV" "$PACKAGE_DIR" | tar -x -C "$WORK"
cd "$WORK/$PACKAGE_DIR"

npm install --no-audit --no-fund

# The import entry from package.json's exports, read as data, never interpolated into script text.
ENTRY="$(node -e 'process.stdout.write(require("./package.json").exports["."].import)')"
if [[ ! -f "$ENTRY" ]]; then
	echo "FAIL $PACKAGE_DIR at $REV: installed, but its entry point $ENTRY wasn't built" >&2
	exit 1
fi
echo "PASS $PACKAGE_DIR at $REV: installs from git and builds $ENTRY"
