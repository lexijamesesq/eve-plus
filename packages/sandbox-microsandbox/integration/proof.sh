#!/usr/bin/env bash
# Real-VM proof for @eve-plus/sandbox-microsandbox, run inside a throwaway container on a KVM host:
#
#   bash proof.sh <repo>
#
# <repo> is an eve-plus checkout at the commit under test. The proof builds this package from it, installs the
# packed package with the eve, ai and vitest versions its own devDependencies name, and runs one vitest test per
# probe against a real microVM, with a live network: it pulls images and probes real hosts. The container is the
# caller's: an eve agent's posture (non-root with the kvm group, only /dev/kvm, a fresh MSB_HOME, the host CA bundle
# read-only, which the host-side msb runtime needs for image pulls), with $HOME writable. Each stage prints
# `stage: <name>` before it starts, and the last lines are `probes: <passed>/<total>` and a `failed: <probe>` line
# per failed probe, so a caller reading only the end of the log can say how far the proof got and what failed.
set -euo pipefail
REPO="$(cd "$1" && pwd)"
PKG="$REPO/packages/sandbox-microsandbox"
NAME=@eve-plus/sandbox-microsandbox
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
cd "$HOME"

dev_dependency() {
	node -e 'process.stdout.write(require(process.argv[1]).devDependencies[process.argv[2]])' "$PKG/package.json" "$1"
}
installed_version() {
	node -e 'process.stdout.write(require(process.argv[1]).version)' "$HOME/node_modules/$1/package.json"
}

echo "stage: build"
(cd "$REPO" && corepack pnpm install --frozen-lockfile --filter "$NAME..." >/dev/null)
(cd "$REPO" && corepack pnpm --filter "$NAME" run build >/dev/null)
mkdir pack
(cd "$REPO" && corepack pnpm --filter "$NAME" pack --pack-destination "$HOME/pack" >/dev/null)

echo "stage: install"
npm init -y >/dev/null
npm install --no-audit --no-fund "$HOME"/pack/*.tgz "eve@$(dev_dependency eve)" "ai@$(dev_dependency ai)" \
	"vitest@$(dev_dependency vitest)" >/dev/null
mkdir stale && npm pack --silent @superradcompany/microsandbox-linux-arm64-gnu@0.7.9 >/dev/null
tar -xzf superradcompany-microsandbox-linux-arm64-gnu-0.7.9.tgz -C stale
mkdir -p stale-home/bin stale-home/lib
cp stale/package/bin/msb stale-home/bin/msb
cp stale/package/lib/libkrunfw.so.* stale-home/lib/
mkdir integration && cp "$PKG"/integration/*.mjs integration/ && cp "$PKG/vitest.integration.config.ts" .
echo "versions: eve $(installed_version eve) microsandbox $(installed_version microsandbox)"

echo "stage: probes"
status=0
npx vitest run --config vitest.integration.config.ts --reporter=default --reporter=json \
	--outputFile.json="$HOME/probes.json" || status=$?
# shellcheck disable=SC2016 # the template literals are JavaScript's, not the shell's
node -e '
	const tests = require(process.argv[1]).testResults.flatMap((file) => file.assertionResults);
	console.log(`probes: ${tests.filter((t) => t.status === "passed").length}/${tests.length}`);
	for (const t of tests) if (t.status !== "passed") console.log(`failed: ${t.title}`);
' "$HOME/probes.json"
exit "$status"
