#!/usr/bin/env bash
# ============================================================================
#  docker-janitor.sh - reclaim VPS disk space without breaking on-demand stacks
#
#  Why this exists: the on-demand gatekeeper stops a stack with
#  `docker compose down` (no -v) and NEVER builds (DEPLOY_BUILD=false). So the
#  images of an asleep stack must stay on disk or its next cold start fails.
#  That rules out the two commands people normally reach for:
#
#      docker image prune -a   -> deletes images of every sleeping stack
#      docker volume prune     -> deletes their Postgres / media volumes
#
#  Both are refused by the guard in assert_safe_command() below.
#
#  What it reclaims, in order:
#    1. dangling <none> images        (left behind by every CI rebuild)
#    2. BuildKit build cache          (capped, 7-day window)
#    3. weekly: stopped containers, unused networks, dangling images again
#    4. weekly: old DB dumps under */backups/ (keeps the newest, never all)
#
#  Container json-log rotation is configured by ops/daemon.json at install time;
#  host access logs by ops/logrotate-vps-access. Neither is done here.
#
#  Usage:
#      docker-janitor.sh              # normal daily pass
#      docker-janitor.sh --weekly     # adds the weekly steps
#      docker-janitor.sh --dry-run    # print what would be pruned, prune nothing
#      docker-janitor.sh --status     # print current numbers only
#
#  Exit codes: 0 ok, 64 refused unsafe command.
# ============================================================================
set -uo pipefail

# --- tunables (env-overridable from the systemd unit) ------------------------
MIN_FREE_BYTES="${MIN_FREE_BYTES:-8589934592}"        # 8 GiB - always reclaim below this
SKIP_ABOVE_BYTES="${SKIP_ABOVE_BYTES:-37580963840}"   # 35 GiB - healthy, skip image step
BUILD_CACHE_KEEP="${BUILD_CACHE_KEEP:-10GB}"
BUILD_CACHE_UNTIL="${BUILD_CACHE_UNTIL:-168h}"        # 7 days
DUMP_KEEP_DAILY="${DUMP_KEEP_DAILY:-7}"
DUMP_KEEP_WEEKLY="${DUMP_KEEP_WEEKLY:-4}"
DUMP_GLOB_ROOT="${DUMP_GLOB_ROOT:-/opt/github}"
LOG_FILE="${JANITOR_LOG:-/var/log/docker-janitor.log}"

WEEKLY=0
DRY_RUN=0
STATUS_ONLY=0
WEEKLY_ON_DOW="${WEEKLY_ON_DOW:-0}"   # 0 = Sunday; "" disables the automatic weekly pass
for arg in "$@"; do
  case "$arg" in
    --weekly)   WEEKLY=1 ;;
    --daily)    WEEKLY=0 ;;
    --dry-run)  DRY_RUN=1 ;;
    --status)   STATUS_ONLY=1 ;;
    -h|--help)  sed -n '2,40p' "$0"; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$arg" >&2; exit 2 ;;
  esac
done
if [ "$WEEKLY" -eq 0 ] && [ -n "$WEEKLY_ON_DOW" ] && [ "$(date -u +%w)" = "$WEEKLY_ON_DOW" ]; then
  WEEKLY=1
fi

# --- logging ----------------------------------------------------------------
log() {
  local line
  line="$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"
  printf '%s\n' "$line"
  if [ -w "${LOG_FILE%/*}" ] 2>/dev/null; then
    printf '%s\n' "$line" >>"$LOG_FILE" 2>/dev/null || true
  fi
}

have() { command -v "$1" >/dev/null 2>&1; }

# --- safety guard -----------------------------------------------------------
# This script must never grow the two dangerous verbs. If a future edit does,
# it dies here instead of on the VPS. Also refuses any internal call attempt.
assert_safe_command() {
  case "$*" in
    *"prune -a"*|*"prune --all"*|*"--volumes"*|*"volume prune"*|*"image prune -a"*|*"image prune --all"*)
      log "REFUSED: '${*}' would break gatekeeper cold starts or delete business data"
      exit 64 ;;
  esac
}

# --- free space -------------------------------------------------------------
free_bytes() {
  df --output=avail -B1 / 2>/dev/null | tail -1 | tr -d ' '
}
human() {
  if have numfmt; then numfmt --to=iec --suffix=B "$1" 2>/dev/null || printf '%s bytes' "$1";
  else printf '%s bytes' "$1"; fi
}

# --- preconditions ----------------------------------------------------------
# A prune racing a build corrupts the build. Skip if one is running.
build_is_running() {
  if have pgrep && pgrep -af 'docker[^ ]* (compose )?build' >/dev/null 2>&1; then
    return 0
  fi
  # A deploy script that has started but not finished leaves a fresh lock.
  if have find && [ -d /opt/github ] && \
     [ -n "$(find "$DUMP_GLOB_ROOT" -maxdepth 3 -name '.build-lock' -mmin -30 2>/dev/null | head -1)" ]; then
    return 0
  fi
  return 1
}

# --- steps ------------------------------------------------------------------
reclaim_dangling_images() {
  assert_safe_command "docker image prune -f"
  local before after
  before="$(free_bytes)"
  if [ "$DRY_RUN" -eq 1 ]; then
    log "DRY-RUN dangling images: $(docker image ls --filter dangling=true -q 2>/dev/null | wc -l) would be removed"
    return
  fi
  local out
  out="$(docker image prune -f 2>&1)" || true
  after="$(free_bytes)"
  log "dangling images: $(printf '%s' "$out" | grep -Ei 'reclaimed|Total' | tr '\n' ' ')"
  log "  step=dangling before=$(human "$before") after=$(human "$after")"
}

reclaim_build_cache() {
  assert_safe_command "docker builder prune -f --keep-storage $BUILD_CACHE_KEEP --filter until=$BUILD_CACHE_UNTIL"
  if [ "$DRY_RUN" -eq 1 ]; then
    log "DRY-RUN build cache: keep ${BUILD_CACHE_KEEP}, drop entries older than ${BUILD_CACHE_UNTIL}"
    return
  fi
  local out
  out="$(docker builder prune -f --keep-storage "$BUILD_CACHE_KEEP" --filter "until=$BUILD_CACHE_UNTIL" 2>&1)" || true
  log "build cache: $(printf '%s' "$out" | grep -Ei 'reclaimed|Total' | tr '\n' ' ')"
}

weekly_system_prune() {
  # No -a, no --volumes: stopped containers + unused networks + dangling images.
  assert_safe_command "docker system prune -f"
  if [ "$DRY_RUN" -eq 1 ]; then
    log "DRY-RUN system prune (weekly): stopped containers, unused networks, dangling images"
    return
  fi
  local out
  out="$(docker system prune -f 2>&1)" || true
  log "system prune: $(printf '%s' "$out" | grep -Ei 'deleted|reclaimed|Total' | tr '\n' ' ')"
}

weekly_trim_dumps() {
  # Per backups directory keep:
  #   - the newest DUMP_KEEP_DAILY files
  #   - one more per distinct ISO week afterwards, for DUMP_KEEP_WEEKLY weeks
  # Everything older is a duplicate snapshot sitting on the same disk as the
  # database it protects. Only *.dump / *.sql directly under a */backups/
  # directory are ever candidates.
  local dirs dir trimmed=0 would=0
  [ -d "$DUMP_GLOB_ROOT" ] || return 0
  dirs="$(find "$DUMP_GLOB_ROOT" -maxdepth 4 -type d -name backups 2>/dev/null)"

  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    local n=0 keep=0 mtime f day seen_weeks=""
    # Newest first: "<epoch mtime> <path>" lines.
    local listing
    listing="$(find "$dir" -maxdepth 1 -type f \( -name '*.dump' -o -name '*.sql' \) \
                 -printf '%T@ %p\n' 2>/dev/null | sort -rn)"
    [ -n "$listing" ] || continue

    while IFS= read -r line; do
      [ -n "$line" ] || continue
      mtime="${line%% *}"
      f="${line#* }"
      keep=0
      day="$(date -u -d "@${mtime%.*}" +%Y-%W 2>/dev/null || echo unknown)"

      # 1) the newest N files outright
      if [ "$n" -lt "$DUMP_KEEP_DAILY" ]; then
        keep=1
      else
        # 2) one more per distinct ISO week, for the first N distinct weeks
        case " $seen_weeks " in
          *" unknown "*|*" $day "*) : ;;
          *)
            if [ "$(printf '%s' "$seen_weeks" | wc -w | tr -d ' ')" -lt "$DUMP_KEEP_WEEKLY" ]; then
              keep=1
              seen_weeks="$seen_weeks $day"
            fi ;;
        esac
      fi

      if [ "$keep" -eq 0 ]; then
        if [ "$DRY_RUN" -eq 1 ]; then
          would=$((would + 1))
          log "DRY-RUN would trim dump: $f"
        elif rm -f -- "$f"; then
          trimmed=$((trimmed + 1))
        fi
      fi
      n=$((n + 1))
    done <<LIST
$listing
LIST
  done <<DIRS
$dirs
DIRS
  if [ "$DRY_RUN" -eq 1 ]; then
    log "weekly dumps: would trim ${would} file(s) under ${DUMP_GLOB_ROOT} (kept newest ${DUMP_KEEP_DAILY} + ${DUMP_KEEP_WEEKLY} weekly per dir)"
  else
    log "weekly dumps: trimmed ${trimmed} file(s) under ${DUMP_GLOB_ROOT} (kept newest ${DUMP_KEEP_DAILY} + ${DUMP_KEEP_WEEKLY} weekly per dir)"
  fi
}

# --- main -------------------------------------------------------------------
main() {
  log "=== docker-janitor start (weekly=$WEEKLY dry_run=$DRY_RUN) ==="

  if ! have docker; then log "docker not found; nothing to do"; exit 0; fi

  local before after
  before="$(free_bytes)"
  log "free before: $(human "$before") (min=$(human "$MIN_FREE_BYTES") skip_above=$(human "$SKIP_ABOVE_BYTES"))"

  if [ "$STATUS_ONLY" -eq 1 ]; then
    docker system df 2>/dev/null || true
    log "dangling images: $(docker image ls --filter dangling=true -q 2>/dev/null | wc -l)"
    log "volumes: $(docker volume ls -q 2>/dev/null | wc -l)"
    exit 0
  fi

  # Below the floor we must act even on a healthy-looking disk; above the skip
  # threshold there is no need to churn images at all.
  local do_images=1
  if [ "$before" -ge "$SKIP_ABOVE_BYTES" ] 2>/dev/null; then
    do_images=0
    log "free space above skip threshold: image prune skipped (build cache still capped)"
  fi

  if [ "$do_images" -eq 1 ]; then
    if build_is_running; then
      log "BUILD_ACTIVE: a docker build is in progress, image prune skipped"
    else
      reclaim_dangling_images
    fi
  fi

  reclaim_build_cache

  if [ "$WEEKLY" -eq 1 ]; then
    weekly_system_prune
    weekly_trim_dumps
  fi

  after="$(free_bytes)"
  log "free after : $(human "$after")"
  log "=== docker-janitor done, reclaimed $(human $(( after - before ))) ==="
}

main
