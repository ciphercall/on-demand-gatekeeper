#!/usr/bin/env bash
# ============================================================================
#  install-janitor.sh - install the host disk janitor (Phase 1)
#
#  Idempotent: safe to run again after a repo update. It never restarts Docker
#  and never touches a running stack, so it cannot interrupt a cold start.
#
#  What it installs:
#    ops/docker-janitor.sh          -> /opt/github/on-demand-gatekeeper/ops/
#    ops/docker-janitor.service     -> /etc/systemd/system/
#    ops/docker-janitor.timer       -> /etc/systemd/system/
#    ops/daemon.json                -> /etc/docker/daemon.json   (log rotation)
#    ops/logrotate-vps-access       -> /etc/logrotate.d/vps-access
#
#  Usage:
#      sudo bash ops/install-janitor.sh            # install / update
#      sudo bash ops/install-janitor.sh --dry-run  # show what would change
#      sudo bash ops/install-janitor.sh --uninstall
# ============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
GK_DIR="/opt/github/on-demand-gatekeeper"
DEST_OPS="$GK_DIR/ops"

DRY_RUN=0
UNINSTALL=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)   DRY_RUN=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help)   sed -n '2,22p' "$0"; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

say()  { printf '%s\n' "$*"; }
run()  { if [ "$DRY_RUN" -eq 1 ]; then say "DRY-RUN: $*"; else "$@"; fi; }

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    say "error: run as root (sudo)" >&2
    exit 1
  fi
}

if [ "$UNINSTALL" -eq 1 ]; then
  say "== uninstalling janitor =="
  run systemctl disable --now docker-janitor.timer     || true
  run rm -f /etc/systemd/system/docker-janitor.timer
  run rm -f /etc/systemd/system/docker-janitor.service
  run systemctl daemon-reload
  run rm -f /etc/logrotate.d/vps-access
  say "left in place (remove manually if wanted):"
  say "  /etc/docker/daemon.json   (container log caps; harmless without the janitor)"
  say "  /var/log/docker-janitor.log"
  exit 0
fi

require_root

say "== installing janitor from $HERE =="

# ---------------------------------------------------------------- 1. scripts --
say "[1/5] janitor script -> $DEST_OPS"
run mkdir -p "$DEST_OPS"
# Run in place from the checkout and source == destination, which `install`
# refuses ("are the same file"). The file is already there and executable's bit
# is set below; only the mode needs enforcing.
if [ "$HERE" = "$DEST_OPS" ]; then
  run chmod 0755 "$DEST_OPS/docker-janitor.sh"
else
  run install -m 0755 "$HERE/docker-janitor.sh" "$DEST_OPS/docker-janitor.sh"
fi

# ------------------------------------------------------------- 2. systemd ----
say "[2/5] systemd unit + timer"
run install -m 0644 "$HERE/docker-janitor.service" /etc/systemd/system/docker-janitor.service
run install -m 0644 "$HERE/docker-janitor.timer"   /etc/systemd/system/docker-janitor.timer
run touch /var/log/docker-janitor.log
run chmod 0644 /var/log/docker-janitor.log
run systemctl daemon-reload
run systemctl enable --now docker-janitor.timer

# ----------------------------------------------------------- 3. daemon.json ---
# Only adds log rotation. Does NOT restart Docker: with live-restore set the
# file takes effect for every container created after this point, which happens
# on the next deploy anyway, and the Phase 2 compose blocks make it immediate.
say "[3/5] /etc/docker/daemon.json (container log caps)"
if [ -f /etc/docker/daemon.json ]; then
  if command -v jq >/dev/null 2>&1; then
    say "     existing daemon.json found - merging log keys with jq"
    run cp -a /etc/docker/daemon.json "/etc/docker/daemon.json.bak.$(date -u +%Y%m%d%H%M%S)"
    if [ "$DRY_RUN" -eq 0 ]; then
      jq -s '.[0] * .[1]' /etc/docker/daemon.json "$HERE/daemon.json" >/tmp/daemon.json.new
      install -m 0644 /tmp/daemon.json.new /etc/docker/daemon.json
    fi
  else
    say "     existing daemon.json found and jq is missing."
    say "     NOT overwriting it. Merge these keys into it by hand:"
    say "         log-driver: json-file"
    say '         log-opts:   { "max-size": "10m", "max-file": "3" }'
    say "         live-restore: true"
  fi
else
  run install -m 0644 "$HERE/daemon.json" /etc/docker/daemon.json
fi

# ---------------------------------------------------------- 4. logrotate -----
say "[4/5] /etc/logrotate.d/vps-access"
run install -m 0644 "$HERE/logrotate-vps-access" /etc/logrotate.d/vps-access
if command -v logrotate >/dev/null 2>&1; then
  if [ "$DRY_RUN" -eq 0 ]; then
    logrotate -d /etc/logrotate.d/vps-access >/dev/null 2>&1 \
      && say "     logrotate dry-run: config OK" \
      || say "     logrotate dry-run reported a problem - inspect /etc/logrotate.d/vps-access"
  fi
fi

# ------------------------------------------------------------- 5. self-test --
say "[5/5] self-test (dry run, deletes nothing)"
if [ "$DRY_RUN" -eq 0 ]; then
  bash "$DEST_OPS/docker-janitor.sh" --dry-run | sed 's/^/     /'
fi

say ""
say "installed. next run:"
systemctl list-timers docker-janitor.timer --no-pager 2>/dev/null | sed 's/^/  /' || true
say ""
say "run now      : systemctl start docker-janitor.service"
say "weekly now   : sudo $DEST_OPS/docker-janitor.sh --weekly"
say "see the log  : tail -f /var/log/docker-janitor.log"
say "disable      : sudo bash $HERE/install-janitor.sh --uninstall"
