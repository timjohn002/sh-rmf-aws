#!/usr/bin/env bash
# One-time setup of an AWS Lightsail instance (Ubuntu 24.04 LTS) for Starhub RMF. Safe to re-run.
#
#   sudo apt-get install -y git
#   sudo git clone https://github.com/timjohn002/sh-rmf-aws.git /opt/starhub-rmf/src
#   sudo bash /opt/starhub-rmf/src/deploy/lightsail/setup.sh [hostname]
#
# Without a hostname it uses <public-ip-with-dashes>.sslip.io, a free name that resolves to this
# server's IP, so HTTPS works before any DNS is set up. The first run stops after creating
# /etc/starhub-rmf/app.env; fill it in and run this script again to start the app.
set -euo pipefail

SRC=/opt/starhub-rmf/src
REPO_URL=https://github.com/timjohn002/sh-rmf-aws.git
ENV_FILE=/etc/starhub-rmf/app.env

main() {
  [ "$(id -u)" -eq 0 ] || { echo "Run with sudo."; exit 1; }

  local host="${1:-}"
  if [ -z "$host" ]; then
    local ip
    ip="$(curl -fsS --max-time 10 https://checkip.amazonaws.com | tr -d '[:space:]')"
    host="${ip//./-}.sslip.io"
  fi
  echo "==> Hostname: $host"

  echo "==> Installing podman, caddy and git"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get install -y -q podman caddy git curl

  if ! swapon --show=NAME --noheadings | grep -qx /swapfile; then
    echo "==> Adding 2 GB of swap (building the image can use more than 2 GB of RAM)"
    [ -f /swapfile ] || { fallocate -l 2G /swapfile; chmod 600 /swapfile; mkswap /swapfile >/dev/null; }
    swapon /swapfile
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
  fi

  [ -d "$SRC/.git" ] || git clone "$REPO_URL" "$SRC"
  local here="$SRC/deploy/lightsail"

  echo "==> Settings: $ENV_FILE"
  install -d -m 700 /etc/starhub-rmf
  if [ ! -f "$ENV_FILE" ]; then
    sed "s|^PUBLIC_SITE_URL=.*|PUBLIC_SITE_URL=https://$host|" "$here/app.env.example" >"$ENV_FILE"
    chmod 600 "$ENV_FILE"
  fi

  echo "==> Caddy (HTTPS) for $host"
  sed "s|__HOST__|$host|g" "$here/Caddyfile.template" >/etc/caddy/Caddyfile
  systemctl enable caddy >/dev/null
  systemctl reload-or-restart caddy

  echo "==> systemd units"
  install -d /etc/containers/systemd
  install -m 644 "$here/starhub-rmf.container" /etc/containers/systemd/
  install -m 644 "$here/starhub-rmf-maintenance.service" "$here/starhub-rmf-maintenance.timer" /etc/systemd/system/
  systemctl daemon-reload

  # Built once here; update.sh rebuilds when the code changes.
  if ! podman image exists localhost/starhub-rmf:latest; then
    echo "==> Building the app image (a few minutes)"
    bash "$here/build-image.sh" "$SRC"
  fi

  if grep -q 'CHANGE-ME' "$ENV_FILE"; then
    echo
    echo "Almost done. Fill in the settings, then run this script again:"
    echo "  sudo nano $ENV_FILE"
    echo "  sudo bash $here/setup.sh $host"
    exit 0
  fi

  echo "==> Starting the app and the hourly maintenance timer"
  systemctl restart starhub-rmf
  systemctl enable --now starhub-rmf-maintenance.timer >/dev/null
  wait_ready
  if curl -fsS --max-time 20 "https://$host/healthz" >/dev/null; then
    echo "==> Ready: https://$host"
  else
    echo "==> The app runs, but https://$host isn't reachable yet. Check that ports 80 and 443 are open"
    echo "    in the Lightsail firewall (Networking tab), then: sudo journalctl -u caddy -n 50"
  fi
}

# Wait for the app to answer /readyz (database reachable).
wait_ready() {
  for _ in $(seq 1 30); do
    curl -fsS --max-time 3 http://127.0.0.1:8080/readyz >/dev/null 2>&1 && return 0
    sleep 2
  done
  echo "The app did not become ready. See: sudo journalctl -u starhub-rmf -n 50"
  exit 1
}

main "$@"
