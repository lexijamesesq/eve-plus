#!/usr/bin/env bash
# check-consumer-install.sh <commit_sha>
#
# PR-time check (no writes outside a temp directory). For each package under packages/, installs it from GitHub at
# <commit_sha> in an empty consumer project, the way a consumer installs it (see write-consumer.mjs), then
# requires every export to exist and load (see resolve-exports.mjs). It catches what a working tree hides: a file
# left out of `files`, a broken export, a build that only works locally.
set -euo pipefail

SHA="$1"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || {
	echo "FAIL: expected a full commit SHA, got '$SHA'" >&2
	exit 1
}
REPO="lexijamesesq/eve-plus"
# The pnpm a consumer pins in its package.json `packageManager`.
CONSUMER_PNPM="pnpm@12.4.2"
SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
WORK_ROOT="${RUNNER_TEMP:-$(mktemp -d)}"
FAILED=0

for PACKAGE_DIR in packages/*/; do
	PACKAGE_DIR="${PACKAGE_DIR%/}"
	CONSUMER="$(mktemp -d "$WORK_ROOT/consumer.XXXXXX")"
	NAME="$(node "$SCRIPTS/write-consumer.mjs" "$PACKAGE_DIR" "$CONSUMER" "$REPO" "$SHA" "$CONSUMER_PNPM")"

	if ! (cd "$CONSUMER" && pnpm install); then
		echo "FAIL $NAME at $SHA: the consumer install failed" >&2
		FAILED=1
		continue
	fi

	cp "$SCRIPTS/resolve-exports.mjs" "$CONSUMER/"
	if (cd "$CONSUMER" && node resolve-exports.mjs "$NAME"); then
		echo "PASS $NAME at $SHA: installs as a consumer does, and every export resolves"
	else
		echo "FAIL $NAME at $SHA: installed, but its exports don't resolve" >&2
		FAILED=1
	fi
done

exit "$FAILED"
