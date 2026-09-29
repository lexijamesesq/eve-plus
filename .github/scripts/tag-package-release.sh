#!/usr/bin/env bash
# tag-package-release.sh <package_dir> <package_name>
#
# Push-time (main only). If the package's declared version isn't tagged on
# origin yet, cuts the annotated tag `<package_name>--v<version>` on HEAD and a
# GitHub Release. Idempotent and re-entrant: the tag-exists check is
# remote-authoritative (git ls-remote), and the Release is checked and created
# independently of the tag, so a failure between the two steps never leaves a
# tag without its Release.
set -euo pipefail

PACKAGE_DIR="$1"
PACKAGE_NAME="$2"

# PACKAGE_DIR is a workflow-controlled literal; the version package.json holds
# is read via argv/json, never interpolated into a -c source, since this job
# holds contents: write and a real token.
CURRENT_VERSION="$(python3 -c "
import json, sys
print(json.load(open(sys.argv[1] + '/package.json'))['version'])
" "$PACKAGE_DIR")"
TAG="${PACKAGE_NAME}--v${CURRENT_VERSION}"

if git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1; then
	echo "$PACKAGE_NAME: $TAG already exists on origin"
else
	echo "$PACKAGE_NAME: tagging $TAG"
	# Annotated, tagged as github-actions[bot]: the estate's drift check audits
	# tag origin and reports a lightweight tag as drift.
	git tag -a "$TAG" -m "$TAG"
	git push origin "refs/tags/$TAG"
	# Remote-authoritative confirmation; the push's own exit status is not proof.
	git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null
fi

if gh release view "$TAG" >/dev/null 2>&1; then
	echo "$PACKAGE_NAME: Release $TAG already exists"
	exit 0
fi

PREV_TAG="$(git tag -l "${PACKAGE_NAME}--v*" --sort=-v:refname | grep -vxF "$TAG" | head -1 || true)"

echo "$PACKAGE_NAME: cutting Release $TAG"
if [[ -n "$PREV_TAG" ]]; then
	gh release create "$TAG" --generate-notes --notes-start-tag "$PREV_TAG"
else
	gh release create "$TAG" --generate-notes
fi
