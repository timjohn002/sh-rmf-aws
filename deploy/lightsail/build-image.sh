#!/usr/bin/env bash
# Build the app image on the Lightsail instance (used by setup.sh and update.sh).
#
#   sudo bash deploy/lightsail/build-image.sh [source dir, default /opt/starhub-rmf/src]
#
# Retries once without the build cache: npm has been seen to skip an optional native
# package (lightningcss) during `npm ci`, which then fails the web app build.
set -euo pipefail

SRC="${1:-/opt/starhub-rmf/src}"
IMAGE=localhost/starhub-rmf:latest

if ! podman build -t "$IMAGE" "$SRC"; then
  echo "==> Build failed; retrying without the build cache"
  podman build --no-cache -t "$IMAGE" "$SRC"
fi
podman image prune -f >/dev/null
