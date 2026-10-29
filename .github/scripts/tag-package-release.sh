#!/usr/bin/env bash
# tag-package-release.sh <package_dir> <package_name>
# Trusted-main release owner. Tags are immutable; worker assets are built from the
# authoritative tagged tree on recovery, and existing assets are never replaced.
set -euo pipefail
PACKAGE_DIR="$1"
PACKAGE_NAME="$2"
CURRENT_VERSION=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]+"/package.json"))["version"])' "$PACKAGE_DIR")
TAG="${PACKAGE_NAME}--v${CURRENT_VERSION}"
SOURCE=$(git rev-parse HEAD)
REMOTE=$(git ls-remote --tags origin "refs/tags/$TAG" "refs/tags/$TAG^{}")
if [[ -n "$REMOTE" ]]; then
	SOURCE=$(printf '%s\n' "$REMOTE" | awk '$2 ~ /\^\{\}$/ {print $1}')
	[[ "$SOURCE" =~ ^[0-9a-f]{40}$ ]] || {
		echo "FAIL: $TAG must be annotated" >&2
		exit 1
	}
	git cat-file -e "$SOURCE^{commit}" 2>/dev/null || git fetch --no-tags origin "$SOURCE"
fi
ASSETS=()
if [[ "$PACKAGE_NAME" == commissioning ]]; then
	ASSET_ROOT=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/commissioning-assets.XXXXXXXX")
	trap 'rm -rf "$ASSET_ROOT"' EXIT
	bash "$(dirname "$0")/build-worker-release.sh" "$SOURCE" "$ASSET_ROOT"
	ASSETS=("$ASSET_ROOT/commissioning-worker-v${CURRENT_VERSION}.tar.gz" "$ASSET_ROOT/commissioning-worker-v${CURRENT_VERSION}.tar.gz.sha256")
fi
if [[ -z "$REMOTE" ]]; then
	echo "$PACKAGE_NAME: tagging $TAG"
	git tag -a "$TAG" "$SOURCE" -m "$TAG"
	if ! git push origin "refs/tags/$TAG"; then
		echo "$PACKAGE_NAME: push rejected; verifying the winning tag"
	fi
fi
WINNER=$(git ls-remote --tags origin "refs/tags/$TAG^{}" | awk '{print $1}')
[[ "$WINNER" == "$SOURCE" ]] || {
	echo "FAIL: $TAG source changed during release; rerun against the winning tag" >&2
	exit 1
}
if ! gh release view "$TAG" >/dev/null 2>&1; then
	PREV_TAG=$(git tag -l "${PACKAGE_NAME}--v*" --sort=-v:refname | grep -vxF "$TAG" | head -1 || true)
	notes=(--generate-notes)
	[[ -n "$PREV_TAG" ]] && notes+=(--notes-start-tag "$PREV_TAG")
	if ! gh release create "$TAG" "${notes[@]}" "${ASSETS[@]}"; then
		gh release view "$TAG" >/dev/null
	fi
fi
for asset in "${ASSETS[@]}"; do
	name=$(basename "$asset")
	if ! gh release view "$TAG" --json assets --jq '.assets[].name' | grep -Fxq "$name"; then
		# A competing publisher can win this upload; only the verified remote bytes establish success.
		gh release upload "$TAG" "$asset" || true
	fi
	RECEIVED=$(mktemp -d "$ASSET_ROOT/received.XXXXXXXX")
	gh release download "$TAG" --pattern "$name" --dir "$RECEIVED"
	cmp "$asset" "$RECEIVED/$name" || {
		echo "FAIL: immutable release asset differs: $name" >&2
		exit 1
	}
done
echo "$PACKAGE_NAME: verified $TAG release${ASSETS:+ and worker assets}"
