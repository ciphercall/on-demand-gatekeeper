#!/usr/bin/env bash
# ============================================================================
#  report.sh - read-only baseline report for VPS disk usage
#
#  Writes nothing to the system it measures. The only file it creates is its own
#  report under ops/reports/. Run it before the janitor's first pass so every
#  "reclaimed X" claim afterwards is measured against a real number.
#
#  Usage:
#      bash ops/report.sh                 # human summary to stdout + file
#      bash ops/report.sh --quiet         # file only
# ============================================================================
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPORT_DIR="${REPORT_DIR:-$HERE/reports}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT="$REPORT_DIR/baseline-$STAMP.txt"
QUIET=0
[ "${1:-}" = "--quiet" ] && QUIET=1

mkdir -p "$REPORT_DIR"

# A tool that is missing must not abort the report: each section is independent.
section() {
  printf '\n===== %s =====\n' "$1" >>"$OUT"
  shift
  "$@" >>"$OUT" 2>&1 || printf '(command failed: %s)\n' "$*" >>"$OUT"
}

{
  printf 'disk-usage baseline\n'
  printf 'host      : %s\n' "$(hostname 2>/dev/null || echo unknown)"
  printf 'generated : %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} >"$OUT"

section "df -h" df -h
section "df -h / (the 100 GB device)" df -h /
section "df --output=avail -B1 /" df --output=avail -B1 /
section "lsblk (is the 200 GB SSD mounted?)" lsblk -o NAME,SIZE,FSTYPE,MOUNTPOINT
section "mount (block devices only)" sh -c "mount | grep -E '^/dev/'"
section "docker system df -v" docker system df -v
section "docker image ls (size desc)" sh -c "docker image ls --format '{{.Repository}}:{{.Tag}}\t{{.Size}}\t{{.ID}}' | head -60"
section "dangling image count" sh -c "docker image ls --filter dangling=true -q | wc -l"
section "docker volume ls" docker volume ls
section "docker builder du" sh -c "docker buildx du 2>/dev/null || docker system df --format '{{.Type}} {{.Size}} {{.Reclaimable}}'"
section "/var/lib/docker" sh -c "du -sh /var/lib/docker/* 2>/dev/null"
section "/ top-level (1 level, sorted)" sh -c "du -xhd1 / 2>/dev/null | sort -h"
section "/opt/github (1 level)" sh -c "du -xhd1 /opt/github 2>/dev/null | sort -h"
section "access logs" sh -c "ls -lhS /opt/github/*/deploy/logs/*.log 2>/dev/null"
section "access log dirs" sh -c "du -sh /opt/github/*/deploy/logs 2>/dev/null"
section "container json logs (top 15)" sh -c "du -sh /var/lib/docker/containers/*/*-json.log 2>/dev/null | sort -h | tail -15"
section "in-repo backups" sh -c "ls -lhS /opt/github/*/backups/* 2>/dev/null | head -30"
section "dashboard sqlite" sh -c "ls -lh /opt/github/vps-dashboard/data/dashboard.db* 2>/dev/null; docker volume inspect vps-dashboard_dashboard-data 2>/dev/null | head -20"
section "running containers" sh -c "docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}'"
section "gatekeeper instances" sh -c "systemctl list-units --type=service --all 2>/dev/null | grep -i gatekeeper; ls -1 /opt/github/on-demand-gatekeeper/.env.* 2>/dev/null"
section "daemon.json" sh -c "cat /etc/docker/daemon.json 2>/dev/null || echo '(none — container logs are unbounded)'"
section "logrotate for access logs" sh -c "ls -l /etc/logrotate.d/ 2>/dev/null"
section "janitor log (if present)" sh -c "tail -20 /var/log/docker-janitor.log 2>/dev/null"

printf 'report written: %s\n' "$OUT"
if [ "$QUIET" -eq 0 ]; then
  printf '\n--- headline ---\n'
  df -h / | sed -n '1,2p'
  printf 'dangling images : %s\n' "$(docker image ls --filter dangling=true -q | wc -l)"
  printf 'docker reclaimable:\n'
  docker system df 2>/dev/null || true
  printf '\nfull report: %s\n' "$OUT"
fi
