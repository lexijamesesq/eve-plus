#!/usr/bin/env bash
# check-consumer-matrix.sh <commit_sha> [commit|tags]
#
# Run from a checkout of <commit_sha>; no writes outside a temp directory. Installs all four packages from GitHub
# next to the exact stable eve build pin with strict peer checking (each runs its own prepare, as a git install does),
# imports their public APIs and writes to the native stores (consumer-agent/smoke.mjs), then compiles an agent that
# mounts the knowledge and working slots, the commissioning extension and the microsandbox sandbox
# (consumer-agent/agent/). Consumers are written by write-consumer.mjs. `tags` installs each package by its release
# tag, `<package>--v<version>` at this checkout's version, wherever that tag points.
#
# A second install with eve 1.0.1, the previous build pin, must fail on the packages' eve peer range.
#
# The build skips sandbox prewarm: preparing the template boots a microVM, which needs a KVM host.
set -euo pipefail

SHA="$1"
REF_MODE="${2:-commit}"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || {
	echo "FAIL: expected a full commit SHA, got '$SHA'" >&2
	exit 1
}
REPO="lexijamesesq/eve-plus"
CONSUMER_PNPM="pnpm@12.4.2"
EVE="1.1.0"
EXCLUDED_EVE="1.0.1"
SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
WORK_ROOT="${RUNNER_TEMP:-$(mktemp -d)}"

case "$REF_MODE" in
commit | tags) ;;
*)
	echo "FAIL: expected commit or tags, got '$REF_MODE'" >&2
	exit 1
	;;
esac
PACKAGES=()
for PACKAGE_DIR in packages/*/; do
	PACKAGE_DIR="${PACKAGE_DIR%/}"
	REF="$SHA"
	if [[ "$REF_MODE" == "tags" ]]; then
		REF="$(basename "$PACKAGE_DIR")--v$(node -p "require('./$PACKAGE_DIR/package.json').version")"
	fi
	PACKAGES+=("$PACKAGE_DIR#$REF")
done

# Writes a consumer of the agent next to eve $1, depending on the rest of the arguments (<package_dir>#<ref>), and
# prints its directory.
new_consumer() {
	local consumer
	consumer="$(mktemp -d "$WORK_ROOT/matrix.XXXXXX")"
	cp -R "$SCRIPTS/consumer-agent/." "$consumer/"
	node "$SCRIPTS/write-consumer.mjs" "$consumer" "$REPO" "$CONSUMER_PNPM" "$@" >/dev/null
	echo "$consumer"
}

# Every slot, the mount and the sandbox the agent declares are in the compiled server.
compiled_whole() {
	local marker
	for marker in consumer-knowledge-v1 consumer-working-v1 commissioning__open eve-plus-microsandbox; do
		grep -rqF -- "$marker" "$1/.output/server" || {
			echo "the build output has no $marker" >&2
			return 1
		}
	done
}

CONSUMER="$(new_consumer "$EVE" "${PACKAGES[@]}")"
if ! (cd "$CONSUMER" && pnpm install); then
	echo "FAIL eve $EVE: the consumer install failed" >&2
	exit 1
fi
if ! (cd "$CONSUMER" && node smoke.mjs); then
	echo "FAIL eve $EVE: installed, but an API or a native store write failed" >&2
	exit 1
fi
BUILT_WITH="$(node -p 'require(process.argv[1]).builtWithEve' "$CONSUMER/node_modules/@eve-plus/commissioning/dist/extension/_manifest.json")"
if [[ "$BUILT_WITH" != "$EVE" ]]; then
	echo "FAIL eve $EVE: commissioning's extension was built with eve $BUILT_WITH, expected $EVE" >&2
	exit 1
fi
if ! (cd "$CONSUMER" && pnpm exec eve build --skip-sandbox-prewarm) || ! compiled_whole "$CONSUMER"; then
	echo "FAIL eve $EVE: the agent doesn't compile" >&2
	exit 1
fi
if ! node -e '
const { schedules } = require(process.argv[1]);
const reconcile = schedules.find(({ name }) => name === "commissioning__reconcile");
if (reconcile?.timezone !== "America/New_York") process.exitCode = 1;
' "$CONSUMER/.output/.eve/compile/compiled-agent-manifest.json"; then
	echo "FAIL eve $EVE: the compiled commissioning reconcile schedule did not retain its configured timezone" >&2
	exit 1
fi
echo "PASS eve $EVE: installs with strict peers, imports, writes, and compiles the agent with the configured timezone"

EXCLUDED_CONSUMER="$(new_consumer "$EXCLUDED_EVE" "${PACKAGES[@]}")"
if (cd "$EXCLUDED_CONSUMER" && pnpm install --lockfile-only) >"$EXCLUDED_CONSUMER/install.log" 2>&1; then
	echo "FAIL eve $EXCLUDED_EVE: strict peers accepted it" >&2
	exit 1
elif grep -qF "unmet peer eve" "$EXCLUDED_CONSUMER/install.log"; then
	echo "PASS eve $EXCLUDED_EVE: strict peers refuse it"
else
	cat "$EXCLUDED_CONSUMER/install.log" >&2
	echo "FAIL eve $EXCLUDED_EVE: the install failed for a reason other than eve's peer range" >&2
	exit 1
fi
