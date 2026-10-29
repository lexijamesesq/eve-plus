#!/usr/bin/env bash
# Build the portable worker from one immutable Git commit, including on release recovery.
set -euo pipefail
SOURCE="$1"
OUTPUT="$2"
[[ "$SOURCE" =~ ^[0-9a-f]{40}$ ]] || {
	echo "FAIL: expected an immutable worker source commit" >&2
	exit 1
}
ROOT=$(git rev-parse --show-toplevel)
EPOCH=$(git show -s --format=%ct "$SOURCE")
mkdir -p "$OUTPUT"
OUTPUT=$(cd "$OUTPUT" && pwd)
BUILD=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/commissioning-worker.XXXXXXXX")
trap 'rm -rf "$BUILD"' EXIT
mkdir "$BUILD/source" "$BUILD/worker"
git -C "$ROOT" archive "$SOURCE" | tar -x -C "$BUILD/source"
pnpm --dir "$BUILD/source" --filter @eve-plus/commissioning install --frozen-lockfile
pnpm --dir "$BUILD/source/packages/commissioning" run build:worker
cp "$BUILD/source/packages/commissioning/.worker-build/index.js" "$BUILD/worker/index.js"
cp "$BUILD/source/packages/commissioning/.worker-build/licenses.txt" "$BUILD/worker/licenses.txt"
cp "$BUILD/source/LICENSE" "$BUILD/worker/LICENSE"
VERSION=$(
	node - "$BUILD/source/packages/commissioning/package.json" "$BUILD/worker/package.json" "$SOURCE" <<'NODE'
const fs = require('node:fs');
const [source, target, gitHead] = process.argv.slice(2);
const { version } = JSON.parse(fs.readFileSync(source, 'utf8'));
fs.writeFileSync(target, JSON.stringify({ name: '@eve-plus/commissioning-worker', version, type: 'module', engines: { node: '>=24' }, gitHead }, null, 2) + '\n');
process.stdout.write(version);
NODE
)
ARCHIVE="commissioning-worker-v${VERSION}.tar.gz"
tar --sort=name --mtime="@$EPOCH" --owner=0 --group=0 --numeric-owner -C "$BUILD/worker" -cf - LICENSE licenses.txt package.json index.js | gzip -n >"$OUTPUT/$ARCHIVE"
(cd "$OUTPUT" && sha256sum "$ARCHIVE" >"$ARCHIVE.sha256")
node "$BUILD/source/packages/commissioning/tests/public-consumer.mjs" "$BUILD/consumer" --worker-archive "$OUTPUT/$ARCHIVE"
echo "Built $ARCHIVE from $SOURCE"
