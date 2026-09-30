#!/usr/bin/env bash
#
# Give back the disk that Docker holds for past deploys. Runs on the HOST, as
# root, started daily by archon-docker-reclaim.timer.
#
# WHY THIS EXISTS. Every deploy builds a new app image and moves the tag onto
# it; the old one stays behind untagged, with its build cache, forever. On
# 2026-09-30 that was most of ~45 GB the container could not see, on a disk
# that reached 100%. The container reclaims its own side (worktree installs,
# the bun cache — see packages/core/src/services/disk-reclaim.ts); only the
# host can reach Docker's.
#
# WHAT IT KEEPS, whatever else happens:
#   - the image the app container is running;
#   - the newest app image older than that — the one a rollback would go back to;
#   - every TAGGED image, including one a deploy has just built and not yet
#     swapped to (the build tags it before the deploy waits for a quiet moment).
# Older untagged app images are removed one by one, without --force, so an
# image some container still references stays and is reported. Other dangling
# images go through `docker image prune`, which never touches an image a
# container references. Build cache older than BUILD_CACHE_MAX_AGE goes.
#
# NOTHING RUNS WHILE A DEPLOY DOES: its build is reading the cache, and its
# image choice is not settled until the swap.
#
# "App image" means: carries the same org.opencontainers.image.source label as
# the image the app container runs. Read from that image rather than written
# here, so an install built from another fork's Dockerfile is judged by its own
# label. An image without the label is not judged at all — nothing is removed
# by name when the family cannot be told apart.
#
# REPORTS: stdout (the journal), one appended line per run in
# <volume>/logs/docker-reclaim.log (readable from inside the container), and a
# ping to HC_PING_URL when set — `/fail` if any step failed.
set -uo pipefail

SERVICE="${SERVICE:-app}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/archon}"
CONTAINER_DATA="${CONTAINER_DATA:-/.archon}"
BUILD_CACHE_MAX_AGE="${BUILD_CACHE_MAX_AGE:-168h}"
DEPLOY_UNIT="${DEPLOY_UNIT:-archon-deploy.service}"
LABEL_KEY="org.opencontainers.image.source"

REPORT=$(mktemp)
trap 'rm -f "$REPORT"' EXIT
failed=0
say() { echo "$*" | tee -a "$REPORT"; }
fail() {
  failed=1
  say "FAILED: $*"
}

compose() { docker compose --project-directory "$DEPLOY_DIR" "$@"; }

free_bytes() { df -B1 --output=avail "${DOCKER_ROOT:-/var/lib/docker}" 2>/dev/null | tail -1 | tr -d ' '; }

finish() {
  local after freed line
  after=$(free_bytes)
  freed=$(( ${after:-0} - ${before:-0} ))
  say "free: ${before:-?} -> ${after:-?} bytes (changed by $freed)"
  line="$(date -u +%Y-%m-%dT%H:%M:%SZ) $([ "$failed" = 0 ] && echo OK || echo FAILED) freed=$freed removed=${removed:-0} kept=${kept:-} $*"
  if [ -n "${LEDGER:-}" ]; then
    mkdir -p "$(dirname "$LEDGER")" && echo "$line" >>"$LEDGER"
  fi
  echo "$line"
  if [ -n "${HC_PING_URL:-}" ]; then
    local url="${HC_PING_URL%/}"
    [ "$failed" = 0 ] || url="$url/fail"
    curl -fsS -m 10 --retry 3 --data-binary @"$REPORT" "$url" >/dev/null ||
      echo "ping to Healthchecks failed" >&2
  fi
  exit "$failed"
}

before=$(free_bytes)
removed=0
kept=""

cid=$(compose ps -q "$SERVICE" 2>/dev/null | head -1)
if [ -z "${LEDGER:-}" ] && [ -n "$cid" ]; then
  volume=$(docker inspect --format \
    "{{range .Mounts}}{{if eq .Destination \"$CONTAINER_DATA\"}}{{.Source}}{{end}}{{end}}" \
    "$cid" 2>/dev/null | head -1)
  [ -n "$volume" ] && LEDGER="$volume/logs/docker-reclaim.log"
fi

if systemctl is-active --quiet "$DEPLOY_UNIT" 2>/dev/null; then
  say "a deploy is running ($DEPLOY_UNIT) — reclaiming nothing this time"
  finish "skipped=deploy-running"
fi

say "== docker disk before"
docker system df 2>&1 | tee -a "$REPORT"

# ── App images ───────────────────────────────────────────────────────────────
if [ -z "$cid" ]; then
  say "no running $SERVICE container — cannot tell which image is live, so no app image is removed"
else
  running=$(docker inspect --format '{{.Image}}' "$cid")
  family=$(docker image inspect --format "{{index .Config.Labels \"$LABEL_KEY\"}}" "$running" 2>/dev/null)
  if [ -z "$running" ] || [ -z "$family" ]; then
    say "running image ${running:-unknown} has no $LABEL_KEY label — no app image is removed"
  else
    say "running image: $running ($family)"
    kept="${running:7:12}"
    running_created=$(docker image inspect --format '{{.Created}}' "$running")
    rollback=""
    # Created times come from `image inspect` for every image, running one
    # included, so all are the same RFC 3339 UTC form and compare as strings.
    # Newest first, so the first untagged image older than the running one is
    # the rollback.
    ids=$(docker images -q --no-trunc --filter "label=$LABEL_KEY=$family" | sort -u)
    while read -r id created tags; do
      [ -n "$id" ] || continue
      [ "$id" = "$running" ] && continue
      if [ "$tags" != "0" ]; then
        say "keep $id — tagged"
      elif [[ ! "$created" < "$running_created" ]]; then
        say "keep $id — newer than the running image"
      elif [ -z "$rollback" ]; then
        rollback="$id"
        kept="$kept,${id:7:12}"
        say "keep $id — rollback image (created $created)"
      elif docker rmi "$id" >>"$REPORT" 2>&1; then
        removed=$((removed + 1))
        say "removed $id (created $created)"
      else
        say "kept $id — docker refused to remove it (see above)"
      fi
    done < <([ -z "$ids" ] || docker image inspect --format '{{.Id}} {{.Created}} {{len .RepoTags}}' $ids | sort -k2 -r)
  fi
fi

# ── Other dangling images, and old build cache ───────────────────────────────
# The label filter keeps the rollback image out of the dangling sweep when it
# could be identified; when it could not, nothing app-labelled is swept either.
if [ -n "${family:-}" ]; then
  docker image prune -f --filter "label!=$LABEL_KEY=$family" 2>&1 | tee -a "$REPORT" ||
    fail "docker image prune"
fi
docker builder prune -f --filter "until=$BUILD_CACHE_MAX_AGE" 2>&1 | tee -a "$REPORT" ||
  fail "docker builder prune"

say "== docker disk after"
docker system df 2>&1 | tee -a "$REPORT"
finish
