#!/usr/bin/env bash
# check-consumer-install.sh <commit_sha> [commit|tags]
#
# For each package under packages/, installs it from GitHub in an empty consumer project and requires every export
# to exist and load (see write-consumer.mjs and resolve-exports.mjs). Then check-consumer-matrix.sh installs all four
# beside the pinned stable eve and compiles an agent. The default checks the given commit. Run with `tags` from the
# release checkout to check each package at the annotated tag for its version. Writes only to temporary directories.
set -euo pipefail

SHA="$1"
REF_MODE="${2:-commit}"
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

case "$REF_MODE" in
commit | tags) ;;
*)
	echo "FAIL: expected commit or tags, got '$REF_MODE'" >&2
	exit 1
	;;
esac

for PACKAGE_DIR in packages/*/; do
	PACKAGE_DIR="${PACKAGE_DIR%/}"
	CONSUMER="$(mktemp -d "$WORK_ROOT/consumer.XXXXXX")"
	# eve at the version the package is built against.
	EVE="$(node -p "require('./$PACKAGE_DIR/package.json').devDependencies.eve")"
	REF="$SHA"
	if [[ "$REF_MODE" == "tags" ]]; then
		REF="$(basename "$PACKAGE_DIR")--v$(node -p "require('./$PACKAGE_DIR/package.json').version")"
	fi
	NAME="$(node "$SCRIPTS/write-consumer.mjs" "$CONSUMER" "$REPO" "$CONSUMER_PNPM" "$EVE" "$PACKAGE_DIR#$REF")"

	if ! (cd "$CONSUMER" && pnpm install); then
		echo "FAIL $NAME at $REF: the consumer install failed" >&2
		FAILED=1
		continue
	fi

	cp "$SCRIPTS/resolve-exports.mjs" "$CONSUMER/"
	if (cd "$CONSUMER" && node resolve-exports.mjs "$NAME"); then
		echo "PASS $NAME at $REF: installs as a consumer does, and every export resolves"
	else
		echo "FAIL $NAME at $REF: installed, but its exports don't resolve" >&2
		FAILED=1
	fi
done

# All four together through to a compiled agent.
bash "$SCRIPTS/check-consumer-matrix.sh" "$SHA" "$REF_MODE" || FAILED=1

exit "$FAILED"
