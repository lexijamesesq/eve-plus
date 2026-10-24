#!/usr/bin/env bash
# Real-VM proof for @eve-plus/sandbox-microsandbox, run on a KVM host with Docker.
#
#   bash run.sh <dir>
#
# <dir> holds this directory's scripts and the package tarball from `npm pack`. The container
# matches an eve agent's posture: node:24-trixie-slim, non-root with the kvm group, only
# /dev/kvm, default AppArmor and seccomp, a fresh MSB_HOME, the host CA bundle read-only (the
# host-side msb runtime needs it for image pulls), and no volumes beyond those. It removes
# itself and <dir> when it ends.
set -uo pipefail
DIR="$1"
NAME=eve-plus-sandbox-proof
KVM="$(stat -c %g /dev/kvm)"
docker rm -f "$NAME" >/dev/null 2>&1
docker run --rm --name "$NAME" --device /dev/kvm --group-add "$KVM" --user node \
	-e MSB_HOME=/home/node/.msb -v "$DIR":/proof:ro -w /home/node \
	-v /etc/ssl/certs/ca-certificates.crt:/etc/ssl/certs/ca-certificates.crt:ro \
	node:24-trixie-slim bash -c '
		set -e
		npm init -y >/dev/null
		npm install --no-audit --no-fund /proof/*.tgz eve@0.83.2 ai@7.0.141 >/dev/null
		mkdir stale && npm pack --silent @superradcompany/microsandbox-linux-arm64-gnu@0.7.9 >/dev/null
		tar -xzf superradcompany-microsandbox-linux-arm64-gnu-0.7.9.tgz -C stale
		mkdir -p stale-home/bin stale-home/lib
		cp stale/package/bin/msb stale-home/bin/msb
		cp stale/package/lib/libkrunfw.so.* stale-home/lib/
		cp /proof/*.mjs .
		a=0; node proof.mjs a || a=$?
		b=0; node proof.mjs b || b=$?
		exit $((a + b))' 2>&1
status=$?
echo "exit: $status"
rm -rf "$DIR"
exit "$status"
