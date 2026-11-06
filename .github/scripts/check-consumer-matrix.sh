#!/usr/bin/env bash
# check-consumer-matrix.sh <commit_sha> [commit|tags]
#
# Run from a checkout of <commit_sha>; no writes outside a temp directory. For each supported eve, installs all four
# packages from GitHub in one consumer with strict peer checking (each runs its own prepare, as a git install does),
# imports their public APIs and writes to the native stores (consumer-agent/smoke.mjs), then compiles an agent that
# mounts the knowledge and working slots, the commissioning extension and the microsandbox sandbox
# (consumer-agent/agent/). Consumers are written by write-consumer.mjs. `tags` installs each package by its release
# tag, `<package>--v<version>` at this checkout's version, wherever that tag points.
#
# Three gates must fail, so the passes mean something:
# - strict peers refuse an eve outside the peer range (EXCLUDED_EVE);
# - strict peers refuse the newest supported eve for a release that predates it (OLD_RANGE_REF);
# - eve 0.91 refuses a commissioning extension built by a newer eve, so its distribution must be built by 0.91.
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
# Every eve the peer ranges admit, oldest first, and one they don't.
SUPPORTED_EVE=("0.91.0" "1.0.0-rc.6")
EXCLUDED_EVE="1.0.0-rc.5"
# The last memory release whose peer range was ^0.91.0 alone.
OLD_RANGE_REF="memory--v0.6.3"
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

for EVE in "${SUPPORTED_EVE[@]}"; do
	CONSUMER="$(new_consumer "$EVE" "${PACKAGES[@]}")"
	if ! (cd "$CONSUMER" && pnpm install); then
		echo "FAIL eve $EVE: the consumer install failed" >&2
		FAILED=1
		continue
	fi
	if ! (cd "$CONSUMER" && node smoke.mjs); then
		echo "FAIL eve $EVE: installed, but an API or a native store write failed" >&2
		FAILED=1
		continue
	fi
	BUILT_WITH="$(node -p "require('$CONSUMER/node_modules/@eve-plus/commissioning/dist/extension/_manifest.json').builtWithEve")"
	if [[ "$BUILT_WITH" != "${SUPPORTED_EVE[0]}" ]]; then
		echo "FAIL eve $EVE: commissioning's extension was built with eve $BUILT_WITH, not ${SUPPORTED_EVE[0]}" >&2
		FAILED=1
		continue
	fi
	if (cd "$CONSUMER" && pnpm exec eve build --skip-sandbox-prewarm) && compiled_whole "$CONSUMER"; then
		echo "PASS eve $EVE: installs with strict peers, imports, writes, and compiles the agent"
	else
		echo "FAIL eve $EVE: the agent doesn't compile" >&2
		FAILED=1
	fi
	if [[ "$EVE" == "${SUPPORTED_EVE[0]}" ]]; then OLDEST_CONSUMER="$CONSUMER"; fi
done

# Requires strict peers to refuse the consumer in $1 on eve's peer range; $2 names what is refused.
refused_on_peers() {
	if (cd "$1" && pnpm install --lockfile-only) >"$1/install.log" 2>&1; then
		echo "FAIL $2: strict peers accepted it" >&2
		FAILED=1
	elif grep -qF "unmet peer eve" "$1/install.log"; then
		echo "PASS $2: strict peers refuse it"
	else
		cat "$1/install.log" >&2
		echo "FAIL $2: the install failed, but not on eve's peer range" >&2
		FAILED=1
	fi
}

refused_on_peers "$(new_consumer "$EXCLUDED_EVE" "${PACKAGES[@]}")" "eve $EXCLUDED_EVE"

NEWEST_EVE="${SUPPORTED_EVE[${#SUPPORTED_EVE[@]} - 1]}"
refused_on_peers "$(new_consumer "$NEWEST_EVE" "packages/memory#$OLD_RANGE_REF")" \
	"$OLD_RANGE_REF next to eve $NEWEST_EVE"

# Commissioning from this checkout, its extension built by the newest eve instead, in the oldest eve's consumer.
if [[ -n "${OLDEST_CONSUMER:-}" ]]; then
	NEWER="$(mktemp -d "$WORK_ROOT/newer.XXXXXX")"
	cp -R packages/commissioning/. "$NEWER/"
	rm -rf "$NEWER/node_modules" "$NEWER/dist"
	node -e '
const fs = require("node:fs");
const file = process.argv[1];
const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
manifest.devDependencies.eve = process.argv[2];
fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
' "$NEWER/package.json" "$NEWEST_EVE"
	printf 'allowBuilds:\n  better-sqlite3: false\nminimumReleaseAge: 0\n' >"$NEWER/pnpm-workspace.yaml"
	(cd "$NEWER" && pnpm install && pnpm pack --out "$NEWER/newer.tgz") >"$NEWER/build.log" 2>&1 || {
		cat "$NEWER/build.log" >&2
		echo "FAIL: couldn't build commissioning with eve $NEWEST_EVE" >&2
		exit 1
	}
	BUILT_WITH="$(tar -xOzf "$NEWER/newer.tgz" package/dist/extension/_manifest.json | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).builtWithEve')"
	[[ "$BUILT_WITH" == "$NEWEST_EVE" ]] || {
		echo "FAIL: commissioning built with eve $NEWEST_EVE records builtWithEve $BUILT_WITH" >&2
		exit 1
	}
	(cd "$OLDEST_CONSUMER" && pnpm add "@eve-plus/commissioning@file:$NEWER/newer.tgz") >"$NEWER/add.log" 2>&1 || {
		cat "$NEWER/add.log" >&2
		echo "FAIL: couldn't install the newer-built commissioning" >&2
		exit 1
	}
	rm -rf "$OLDEST_CONSUMER/.output" "$OLDEST_CONSUMER/.eve"
	if (cd "$OLDEST_CONSUMER" && pnpm exec eve build --skip-sandbox-prewarm) >"$NEWER/eve-build.log" 2>&1; then
		echo "FAIL eve ${SUPPORTED_EVE[0]}: compiled a commissioning extension built with eve $NEWEST_EVE" >&2
		FAILED=1
	elif grep -qF "was built with eve $NEWEST_EVE" "$NEWER/eve-build.log"; then
		echo "PASS eve ${SUPPORTED_EVE[0]}: refuses commissioning built with eve $NEWEST_EVE"
	else
		cat "$NEWER/eve-build.log" >&2
		echo "FAIL eve ${SUPPORTED_EVE[0]}: the newer-built commissioning failed, but not on its eve version" >&2
		FAILED=1
	fi
fi

exit "$FAILED"
