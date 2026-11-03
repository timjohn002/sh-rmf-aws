#!/usr/bin/env bash
# Deploy the latest code from GitHub (main) on the Lightsail instance:
# pull, rebuild the image, refresh the systemd units, restart the app.
#
#   sudo bash /opt/starhub-rmf/src/deploy/lightsail/update.sh
set -euo pipefail

SRC=/opt/starhub-rmf/src

# Everything runs from main(), which bash has read in full before `git pull` can change this file.
main() {
  [ "$(id -u)" -eq 0 ] || { echo "Run with sudo."; exit 1; }
  local here="$SRC/deploy/lightsail"

  echo "==> Pulling the latest code"
  git -C "$SRC" pull --ff-only
  git -C "$SRC" log --oneline -1

  echo "==> Building the app image (a few minutes)"
  bash "$here/build-image.sh" "$SRC"

  install -m 644 "$here/starhub-rmf.container" /etc/containers/systemd/
  install -m 644 "$here/starhub-rmf-maintenance.service" "$here/starhub-rmf-maintenance.timer" /etc/systemd/system/
  systemctl daemon-reload

  echo "==> Restarting the app"
  systemctl restart starhub-rmf
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 3 http://127.0.0.1:8080/readyz >/dev/null 2>&1; then
      echo "==> Updated and ready"
      return 0
    fi
    sleep 2
  done
  echo "The app did not become ready. See: sudo journalctl -u starhub-rmf -n 50"
  exit 1
}

main "$@"
