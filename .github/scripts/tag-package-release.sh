#!/usr/bin/env bash
# tag-package-release.sh <package_dir> <package_name>
#
# Push-time (main only). If the package's declared version isn't tagged on
# origin yet, cuts the annotated tag `<package_name>--v<version>` on HEAD and a
# GitHub Release. Idempotent and re-entrant: both checks are remote-authoritative,
# and the Release is ensured on every run, whether this run cut the tag or found
# it. The two are separate remote writes, so a failure between them leaves the
# tag without its Release and fails the job; re-running it, or any later run at
# the same version, cuts the missing Release.
#
# Push runs don't queue behind each other (each has its own concurrency group),
# so two quick merges can release the same version at once. Losing either race
# is success: the other run made the tag or Release this one was about to.
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
	if ! git push origin "refs/tags/$TAG"; then
		echo "$PACKAGE_NAME: push of $TAG rejected; checking whether another run tagged it"
	fi
	# Remote-authoritative confirmation; the push's own exit status is not proof.
	git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null
fi

if gh release view "$TAG" >/dev/null 2>&1; then
	echo "$PACKAGE_NAME: Release $TAG already exists"
	exit 0
fi

PREV_TAG="$(git tag -l "${PACKAGE_NAME}--v*" --sort=-v:refname | grep -vxF "$TAG" | head -1 || true)"
notes=(--generate-notes)
[[ -n "$PREV_TAG" ]] && notes+=(--notes-start-tag "$PREV_TAG")

echo "$PACKAGE_NAME: cutting Release $TAG"
if ! gh release create "$TAG" "${notes[@]}"; then
	gh release view "$TAG" >/dev/null
	echo "$PACKAGE_NAME: Release $TAG was cut by another run"
fi
