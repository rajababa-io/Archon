#!/usr/bin/env bash
#
# Deploy this checkout to the local Docker install, verifying every step.
#
# Run on the HOST (it needs docker), not inside the container:
#
#   sudo bash /opt/archon/scripts/deploy-local.sh
#
# WHY THIS EXISTS. Deploying is seven steps and each one can succeed while doing
# nothing. In one evening: a push that was never run, a pull blocked by git's
# ownership guard, and two builds from a checkout that had not moved — every
# one reported success, and three of four deploys shipped the wrong commit
# without saying so.
#
# So the rule here is that no step is trusted to have worked. Each one is
# followed by a question whose answer comes from somewhere else: GitHub is
# asked for the SHA it now has, the deploy checkout is asked what its HEAD is,
# and the running container is asked which commit it was built from. A step
# whose effect cannot be confirmed stops the deploy.
#
# The layout it assumes, all overridable:
#   SOURCE_DIR   where the work happens — inside the container
#   DEPLOY_DIR   the docker build CONTEXT — a SEPARATE clone, on the host
#   The source is not bind-mounted into the image, which is why a rebuild is
#   required for server changes and a restart alone does nothing.
#
# WHAT IT WILL NOT DO. Recreating the container destroys whatever it is
# holding: a turn in flight, a message queued behind one, a workflow run that
# comes back as a `running` row nobody finishes. So step 5 gets the box to a
# moment when none of those exist before it swaps. A chat that is merely open is
# not one of them — its provider session id is persisted, so it resumes with its
# context intact.
#
# It MAKES that moment rather than waiting for one, when it can. With a drain
# token configured it tells the server to stop admitting work and waits for what
# it already holds to finish; without one it falls back to polling for an instant
# when the whole box happens to be idle, which on a busy box may never come.
#
# Finishing is not always possible either: agent turns run for tens of minutes,
# several at once, and a box that never finishes never deploys. So after a grace
# window the drain PARKS what is still running — interrupts chat turns and saves
# the messages queued behind them, pauses the workflow runs the server executes —
# and the new server resumes that work when it boots. DRAIN_PARK=0 turns this off
# and waits, exactly as before.
set -euo pipefail

SOURCE_DIR="${SOURCE_DIR:-/home/appuser/archon-upstream}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/archon}"
SOURCE_BRANCH="${SOURCE_BRANCH:-local/deploy}"
REMOTE="${REMOTE:-fork}"
REMOTE_BRANCH="${REMOTE_BRANCH:-deploy}"
# What `deploy` must never get ahead of. Named here so the guard in step 1 and
# the message it fails with cannot disagree about which branch is the source of
# truth.
DEV_BRANCH="${DEV_BRANCH:-dev}"
SERVICE="${SERVICE:-app}"
HEALTH_URL="${HEALTH_URL:-http://localhost:3000/api/health}"
# The deadline of the systemd service that runs this deploy (TimeoutStartSec),
# so the wait in step 5 can be given a SLICE of it rather than a number that
# happens to be the same. Those two were both 1800s, and on 2026-09-23 a deploy
# spent 27m34s waiting for a turn-gap, swapped the container at 15:43:46, and
# was killed by systemd while the new image was still booting — the swap had
# happened, and no verdict was written anywhere.
DEPLOY_BUDGET_SECONDS="${DEPLOY_BUDGET_SECONDS:-1800}"
# What the swap needs AFTER the wait ends: `up -d`, a cold start answering the
# health check, and step 7. Held back from the wait rather than hoped for.
SWAP_RESERVE_SECONDS="${SWAP_RESERVE_SECONDS:-420}"
STARTED_AT=$(date -u +%s)
# How long step 5 lets the box finish on its own before it parks what is left.
# Parking only happens on the drain path, and only when this is shorter than the
# wait itself.
DRAIN_PARK="${DRAIN_PARK:-1}"
DRAIN_GRACE_SECONDS="${DRAIN_GRACE_SECONDS:-600}"
# After the swap: how long to wait for the new server to report the parked work
# resumed, and where to leave the one-line report (deploy-on-request.sh reads it).
PARK_REPORT_WAIT="${PARK_REPORT_WAIT:-60}"
PARK_REPORT_FILE="${PARK_REPORT_FILE:-}"

# Derived from HEALTH_URL rather than defaulted beside it, so an operator who
# repoints one cannot leave the other addressing a different server. An override
# that is not the standard path leaves this empty on purpose: step 5 then says so
# and asks for DRAIN_URL, instead of inventing a URL out of a string it did not
# recognise.
case "$HEALTH_URL" in
  */api/health) DRAIN_URL="${DRAIN_URL:-${HEALTH_URL%/api/health}/internal/drain}" ;;
  *) DRAIN_URL="${DRAIN_URL:-}" ;;
esac

# The token comes from the HOST's own env file, not from the container's
# environment, even though both have it. The half that ARMS drain must be the
# half that cancels it, and the cancel has to survive this script dying — that is
# a shell trap here, so the credential belongs here too.
#
# An install with no token is not an error: step 5 falls back to the turn-gap
# poll and behaves exactly as it did before drain existed.
DRAIN_ENV_FILE="${DRAIN_ENV_FILE:-$DEPLOY_DIR/.env}"
drain_token="${ARCHON_DRAIN_TOKEN:-}"
if [ -z "$drain_token" ] && [ -r "$DRAIN_ENV_FILE" ]; then
  # Value only, quotes stripped, first match wins. Never echoed: this script's
  # output is kept as /.archon/deploy-last.log, and a bearer token in a deploy
  # log is a credential leak into a file several sessions read.
  drain_token=$(sed -n 's/^[[:space:]]*ARCHON_DRAIN_TOKEN=//p' "$DRAIN_ENV_FILE" \
    | head -1 | tr -d '\r' | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/")
fi

# Timestamped, because this log is the only post-mortem anyone gets and it
# could not answer "how long was it in step 5" — the difference between a build
# that dragged and a wait that never ended.
step() { printf '\n\033[1m── %s  [%s]\033[0m\n' "$1" "$(date -u '+%H:%M:%SZ')"; }
die() { printf '\n\033[31mSTOPPED: %s\033[0m\n' "$1" >&2; exit 1; }

# Everything container-side runs as root through one helper: the two checkouts
# are owned by different users and root is neither, so git's dubious-ownership
# guard fires on both. It is set here rather than asked of the operator because
# forgetting it is one of the ways a deploy silently did nothing.
in_container() {
  docker compose exec -T -u root "$SERVICE" sh -lc "git config --global --add safe.directory '*' >/dev/null 2>&1; $1"
}

# One HTTP call to the drain endpoint, printing only the status code.
#
# The bearer is fed through `--config -` on STDIN rather than as `-H`, because
# argv is world-readable in /proc on the box this runs on and several
# unprivileged sessions share it. Nothing this function prints contains the
# token.
#
#   drain_call METHOD [BODY] [PATH-UNDER-/internal/drain] [BODY-OUT-FILE] [MAX-SECONDS]
drain_call() {
  local method="$1" body="${2:-}" path="${3:-}" out="${4:-/dev/null}" max_time="${5:-20}"
  local args=(-sS --max-time "$max_time" -o "$out" -w '%{http_code}' --config - -X "$method")
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' --data "$body")
  printf 'header = "Authorization: Bearer %s"\n' "$drain_token" | curl "${args[@]}" "$DRAIN_URL$path"
}

# Whether this script has told the server to stop accepting work. The single most
# important variable here: if the deploy dies while this is 1 and nothing
# cancels, the box refuses ALL new work until the budget lapses — up to an hour.
DRAIN_ARMED=0

# Cancelled from a trap, so that every way out of this script goes through it:
# `die`, an unexpected non-zero under `set -e`, and the SIGTERM
# deploy-on-request.sh sends when systemd's deadline expires. DELETE
# /internal/drain is idempotent by design, so this may run twice or run against a
# server that was never draining.
cancel_drain() {
  [ "$DRAIN_ARMED" = "1" ] || return 0
  DRAIN_ARMED=0
  local code=""
  code=$(drain_call DELETE 2>/dev/null) || code=""
  case "$code" in
    200) echo "drain cancelled — the server is accepting work again" ;;
    *) printf '\033[31mcould not cancel drain (HTTP %s) — the box will refuse new work until the budget lapses\033[0m\n' "${code:-no answer}" ;;
  esac
}
# Set once step 5 has parked work, so the report after the swap knows what to ask
# the new server about. The cancel above is also the UN-park: the old server
# hands parked work straight back when its drain is cancelled.
PARK_DRAIN_ID=""

# The signal handler also stops the WAITER, by its recorded PID and never by a
# name match. See the background-child note in step 5 for why there is a PID to
# record at all.
trap cancel_drain EXIT
trap 'kill -TERM "${DRAIN_WAIT_PID:-}" 2>/dev/null; cancel_drain; exit 143' INT TERM

cd "$DEPLOY_DIR" || die "no deploy directory at $DEPLOY_DIR"

# ── 1. Preflight ────────────────────────────────────────────────────────────
# What gets built is the COMMITTED SHA, so uncommitted work is a warning and
# not a failure. It was a failure for one evening, until the first run on this
# box stopped on sixteen files belonging to a different session: several agents
# share this checkout, so "clean" is a state it is never in, and a guard that
# can never pass is a guard that gets deleted or bypassed.
#
# The warning still earns its place — the trap is deploying and expecting an
# edit that was never committed to be in it.
#
# There is deliberately NO test step. Tests would have to run in the source
# checkout, which contains whatever every other session is mid-way through, so
# a red run would say nothing about the commit being shipped. A check that
# cannot be trusted is worse than no check; tests belong to the commit, and
# this script's honest job is proving that a specific SHA reached the
# container.
step "1/7  Preflight"
SHA=$(in_container "git -C '$SOURCE_DIR' rev-parse HEAD" | tr -d '\r\n')
[ -n "$SHA" ] || die "could not read the source HEAD"
echo "source HEAD: $SHA"

DIRTY_COUNT=$(in_container "git -C '$SOURCE_DIR' status --porcelain --untracked-files=no | wc -l" | tr -d ' \r\n')
if [ "${DIRTY_COUNT:-0}" != "0" ]; then
  printf '\033[33mnote: %s uncommitted file(s) in the source checkout — they will NOT be deployed\033[0m\n' "$DIRTY_COUNT"
fi

# THE INVARIANT: the commit being deployed is already on `dev`. Checked HERE,
# before step 2 pushes it to `deploy`, because after that push the mistake is
# published. Run in the SOURCE checkout through the container: that is the only
# place that has both this commit and a `dev` ref to compare it against — the
# host's build context is still on the previous commit until step 3.
#
# See scripts/assert-deploy-on-dev.sh for why `deploy` is a pointer.
in_container "cd '$SOURCE_DIR' && bash scripts/assert-deploy-on-dev.sh '$SHA'" \
  || die "$SHA is not on $DEV_BRANCH — merge it to $DEV_BRANCH first; deploy only points at commits $DEV_BRANCH has"

# ── 2. Ask GitHub what it has, and push only if it is behind ────────────────
# ASKED FIRST, pushed second. The requester pushes before it writes the request
# (see request-deploy.sh), because the container is the half that holds GitHub
# credentials — its token is injected per call by the env-var store and is not
# in the container's own environment, so a push issued from HERE, through
# `docker compose exec`, sees only whatever stale token the image was built
# with. That is what stopped two deploys: one on a token that had been rotated,
# one on no credential at all.
#
# Nothing is lost by asking first. The remote's own answer was always the
# evidence this step trusted — the push was only ever how the answer became
# true, and it is still attempted when the remote is genuinely behind, which is
# what a manual run of this script needs.
step "2/7  Confirm $REMOTE/$REMOTE_BRANCH has $SHA"
remote_sha() {
  in_container "cd '$SOURCE_DIR' && git ls-remote '$REMOTE' 'refs/heads/$REMOTE_BRANCH' | cut -f1" \
    | tr -d '\r\n'
}

REMOTE_SHA=$(remote_sha)
if [ "$REMOTE_SHA" != "$SHA" ]; then
  echo "remote is at ${REMOTE_SHA:-nothing} — pushing"
  in_container "cd '$SOURCE_DIR' && git push '$REMOTE' '$SOURCE_BRANCH:$REMOTE_BRANCH' 2>&1 | tail -2" \
    || die "remote is at ${REMOTE_SHA:-nothing} and the push failed — push from the source checkout, which has the credentials"
  REMOTE_SHA=$(remote_sha)
fi

[ "$REMOTE_SHA" = "$SHA" ] || die "remote is at ${REMOTE_SHA:-nothing}, expected $SHA"
echo "remote confirms: $REMOTE_SHA"

# ── 3. Pull into the build context, then assert it moved ────────────────────
# ON THE HOST, not through the container. $DEPLOY_DIR is the host's own build
# context — `docker compose build` reads it from here, two steps down — and it
# is visible to the container only through a bind mount declared in
# docker-compose.override.yml. Routing this git through that mount made the
# deploy depend on something that has nothing to do with it, and when a compose
# invocation carrying -f recreated the app container without the override, this
# step died on a directory the host could see the whole time. Three deploys
# failed here before the cause was the mount rather than the pull.
#
# Needs no credentials: the fork is public, and reading from it authenticates
# against nothing. The push is the half that needs a token, and it belongs to
# the container — see request-deploy.sh.
#
# safe.directory because the checkout is owned by neither root nor the invoking
# user, which is git's dubious-ownership guard and another way this has
# silently done nothing.
step "3/7  Pull into $DEPLOY_DIR"
command -v git >/dev/null 2>&1 \
  || die "the host has no git, and $DEPLOY_DIR is the host's build context"
git -c safe.directory='*' -C "$DEPLOY_DIR" pull --ff-only "$REMOTE" "$REMOTE_BRANCH" 2>&1 | tail -2 \
  || die "pull failed — resolve it in $DEPLOY_DIR by hand"

DEPLOY_SHA=$(git -c safe.directory='*' -C "$DEPLOY_DIR" rev-parse HEAD | tr -d '\r\n')
[ "$DEPLOY_SHA" = "$SHA" ] || die "build context is at $DEPLOY_SHA, expected $SHA — building it would ship the wrong commit"
echo "build context confirms: $DEPLOY_SHA"

# ── 4. Build ────────────────────────────────────────────────────────────────
# The SHA goes INTO the image so step 7 can ask what is running instead of
# inferring it from what was built.
#
# Built BEFORE the wait, deliberately. The build takes minutes and disturbs
# nothing; spending them after a quiet moment was found would spend the moment
# itself, and the box would be busy again by the time there was an image.
step "4/7  Build"
docker compose build --build-arg "GIT_SHA=$SHA" "$SERVICE" || die "build failed"

# ── 5. Get the box to a moment when nothing is mid-flight ───────────────────
# Asked of the server that is ABOUT TO BE REPLACED, because it is the only thing
# that knows what it is holding.
#
# TWO PATHS, and which one runs depends only on whether a drain token is
# configured. With one, the server is told to stop admitting work and this waits
# for what it already holds to finish — a count that only ever falls. Without
# one, it falls back to scripts/turn-gap.ts, which polls for an instant when the
# whole box happens to be idle; see that file for what counts as busy and why an
# unreadable answer is treated as busy. The fallback is not a lesser mode of the
# same thing, it is what this step did before drain existed, kept working
# unchanged for an install that has configured no token.
#
# Both readers run inside the container: bun is there, and so is the health
# endpoint. They ride the source checkout, which deploy-on-request.sh has already
# confirmed is at the commit being shipped. The arming and cancelling stay out
# here on the host — see cancel_drain above.
step "5/7  Wait for the box to hold nothing"
if [ "${SKIP_TURN_GAP:-0}" = "1" ]; then
  # The escape hatch, for a box wedged badly enough that waiting for it to go
  # quiet is waiting forever. It ends live turns. Announced rather than silent,
  # because the whole point of this step is that nobody reaches it by accident.
  #
  # It is NOT drain and must never quietly become it: drain finishes the work,
  # this discards it. An operator who wants the work finished wants the drain
  # path, which is what happens when this is left alone.
  printf '\033[33mSKIP_TURN_GAP=1 — swapping without waiting; work in flight WILL be lost\033[0m\n'
else
  # Whatever is left of the service's deadline once the build has taken what it
  # took, minus the reserve the swap needs. An explicit TURN_GAP_TIMEOUT still
  # wins: this derives a default, it does not override an operator.
  gap_budget=$((DEPLOY_BUDGET_SECONDS - ($(date -u +%s) - STARTED_AT) - SWAP_RESERVE_SECONDS))
  if [ "${TURN_GAP_TIMEOUT:-}" = "" ] && [ "$gap_budget" -le 0 ]; then
    die "the build left no room to swap inside the ${DEPLOY_BUDGET_SECONDS}s deploy budget — NOTHING was deployed, and it is still running what it was. Re-run, or raise DEPLOY_BUDGET_SECONDS and TimeoutStartSec together."
  fi
  gap_timeout="${TURN_GAP_TIMEOUT:-$gap_budget}"

  if [ -n "$drain_token" ] && [ -z "$DRAIN_URL" ]; then
    die "a drain token is configured but $HEALTH_URL is not the standard /api/health path, so the drain endpoint cannot be derived from it — set DRAIN_URL, or clear ARCHON_DRAIN_TOKEN to use the turn-gap poll"
  fi

  if [ -n "$drain_token" ]; then
    # The drain must outlast the WAIT and the SWAP, or the server starts
    # accepting work again in the seconds between this step succeeding and the
    # container stopping. So it is armed for the whole of what is left of the
    # deploy budget — the same arithmetic as the wait, plus the reserve the wait
    # holds back — clamped by the endpoint's own maximum.
    #
    # The clamp is computed by the script that IMPORTS that maximum from the
    # route enforcing it, rather than by a copy of the number in this shell.
    drain_budget=$(in_container "cd '$SOURCE_DIR' && bun scripts/drain-wait.ts --budget $((gap_timeout + SWAP_RESERVE_SECONDS))" | tr -d ' \r\n')
    case "$drain_budget" in
      '' | *[!0-9]*) die "could not read the drain budget limit from the container, so nothing was armed — NOTHING was deployed" ;;
    esac
    [ "$drain_budget" -gt 0 ] || die "the drain budget came back as ${drain_budget}s — NOTHING was deployed"

    # ARMED BEFORE THE CALL, deliberately. If the POST lands and its answer is
    # lost, the server is draining and this script does not know it; setting the
    # flag first means the trap cancels anyway. The reverse order leaves a box
    # refusing work with nobody holding the cancel.
    # Parking needs the grace to end before the wait does; otherwise there is no
    # time left after it to park in, and this is the plain wait. Decided before
    # the drain is armed so the server can be told when parking will start: the
    # console counts down to it (#211).
    first_wait=$gap_timeout
    grace_field=""
    if [ "$DRAIN_PARK" != "0" ] && [ "$DRAIN_GRACE_SECONDS" -lt "$gap_timeout" ]; then
      first_wait=$DRAIN_GRACE_SECONDS
      grace_field=",\"graceSeconds\":$DRAIN_GRACE_SECONDS"
    fi

    DRAIN_ARMED=1
    drain_code=$(drain_call POST "{\"budgetSeconds\":$drain_budget$grace_field}") || drain_code=""
    case "$drain_code" in
      200) ;;
      401) die "the drain endpoint rejected the token in $DRAIN_ENV_FILE — NOTHING was deployed" ;;
      400) die "the drain endpoint rejected a ${drain_budget}s budget — NOTHING was deployed" ;;
      404) die "there is no drain endpoint at $DRAIN_URL — the running server predates drain, or was started without a token. NOTHING was deployed" ;;
      *) die "could not reach the drain endpoint at $DRAIN_URL (HTTP ${drain_code:-no answer}) — NOTHING was deployed" ;;
    esac
    echo "drain armed for ${drain_budget}s — the server is refusing new work and finishing what it has"
    echo "waiting up to ${gap_timeout}s, holding ${SWAP_RESERVE_SECONDS}s back for the swap"
    if [ "$first_wait" != "$gap_timeout" ]; then
      echo "after ${DRAIN_GRACE_SECONDS}s, whatever is still running is parked and resumed by the new server"
    fi
    wait_started=$(date -u +%s)
    # The `draining:` lines below name what is still holding this up. When one of
    # them is a chat, read it literally — including when that chat is the one that
    # asked for the deploy. Drain refuses NEW work and waits out what is already in
    # flight, so a conversation that keeps taking turns to check on its own deploy
    # is indistinguishable from any other busy chat, and waits forever. See the
    # note in request-deploy.sh; this is how it looks from the host.

    # A BACKGROUND CHILD, waited on, so that a signal is handled when it arrives
    # rather than after the wait returns: bash defers a trap until the foreground
    # command finishes, and for this one that is up to half an hour away. Held in
    # the foreground, the SIGTERM deploy-on-request.sh sends on systemd's deadline
    # would never reach cancel_drain before the cgroup was killed — and a box left
    # refusing every new message for the rest of the budget is the worst thing
    # this whole mechanism can do.
    #
    # `|| drain_status=$?` and not a bare `wait`: under `set -e` a non-zero exit
    # would end the script before the case below could say which non-zero it was,
    # and each of these needs different words.
    wait_for_drain() {
      drain_status=0
      in_container "cd '$SOURCE_DIR' && HEALTH_URL='$HEALTH_URL' DRAIN_WAIT_TIMEOUT='$1' DRAIN_WAIT_INTERVAL='${DRAIN_WAIT_INTERVAL:-}' bun scripts/drain-wait.ts" &
      DRAIN_WAIT_PID=$!
      wait "$DRAIN_WAIT_PID" || drain_status=$?
      DRAIN_WAIT_PID=""
    }
    wait_for_drain "$first_wait"

    # THE PARK. Only after the grace ran out with something still held. The
    # server interrupts web chats and saves their queued messages, pauses the
    # workflow runs it executes, and names what it could not park — those this
    # keeps waiting for, for the rest of the budget. A park that fails dies here,
    # and the trap's cancel hands everything already parked straight back.
    if [ "$first_wait" != "$gap_timeout" ] && [ "$drain_status" = "1" ]; then
      echo "the grace of ${DRAIN_GRACE_SECONDS}s is over — parking what is still running"
      park_body=$(mktemp)
      park_code=$(drain_call POST '{}' /park "$park_body" 180) || park_code=""
      case "$park_code" in
        200) ;;
        404) die "the running server has no park endpoint — it predates parking. NOTHING was deployed. Re-run with DRAIN_PARK=0 to wait without parking." ;;
        409) die "the drain lapsed before anything was parked — NOTHING was deployed" ;;
        *) die "parking failed (HTTP ${park_code:-no answer}) — NOTHING was deployed, and whatever was parked is handed back to the running server" ;;
      esac
      park_lines=$(in_container "cd '$SOURCE_DIR' && bun scripts/drain-wait.ts --park-answer" <"$park_body") \
        || die "could not read what was parked — NOTHING was deployed, and whatever was parked is handed back to the running server"
      rm -f "$park_body"
      PARK_DRAIN_ID=$(printf '%s\n' "$park_lines" | head -1)
      printf '%s\n' "$park_lines" | tail -n +2

      remaining=$((gap_timeout - ($(date -u +%s) - wait_started)))
      if [ "$remaining" -gt 0 ]; then
        wait_for_drain "$remaining"
      fi
      case $drain_status in
        1) die "drain parked what it could, but what it could not park never finished within ${gap_timeout}s — NOTHING was deployed, and the parked work is handed back to the running server. Ask again later, or set SKIP_TURN_GAP=1 to swap anyway and lose the work in flight." ;;
      esac
    fi

    case $drain_status in
      0) ;;
      1) die "drain was armed but the box never finished what it was holding within ${gap_timeout}s — NOTHING was deployed, and it is still running what it was. Ask again later, or set SKIP_TURN_GAP=1 to swap anyway and lose the work in flight." ;;
      3) die "the drain stopped being in effect while the deploy waited — its budget lapsed, or something else cancelled it. NOTHING was deployed." ;;
      *) die "could not read what the drain is holding, so the container was left alone — NOTHING was deployed" ;;
    esac
  else
    echo "no drain token configured — falling back to waiting for a turn-gap"
    echo "waiting up to ${gap_timeout}s, holding ${SWAP_RESERVE_SECONDS}s back for the swap"

    gap_status=0
    in_container "cd '$SOURCE_DIR' && HEALTH_URL='$HEALTH_URL' TURN_GAP_TIMEOUT='$gap_timeout' TURN_GAP_INTERVAL='${TURN_GAP_INTERVAL:-}' TURN_GAP_CONFIRM='${TURN_GAP_CONFIRM:-}' bun scripts/turn-gap.ts" \
      || gap_status=$?
    case $gap_status in
      0) ;;
      1) die "the box never went quiet within ${gap_timeout}s — NOTHING was deployed, and it is still running what it was. Ask again later, or set SKIP_TURN_GAP=1 to swap anyway and lose the work in flight." ;;
      *) die "could not read what the container is holding, so it was left alone — NOTHING was deployed" ;;
    esac
  fi
fi

# ── 6. Up ───────────────────────────────────────────────────────────────────
# From here on a cancel is no longer safe: the caller stops honouring one once
# this file exists (#211). Touched BEFORE the step marker, so there is no moment
# where the log says the swap has begun and a cancel could still be acted on.
[ -n "${SWAP_MARKER_FILE:-}" ] && touch "$SWAP_MARKER_FILE"
step "6/7  Restart and wait for health"
docker compose up -d "$SERVICE" || die "up failed"

# Disarmed only once the swap has happened. The process that was draining no
# longer exists, so there is nothing left to cancel — and until this line, a
# failing `up -d` still goes out through the trap, because a box left drained
# with its old container still serving is the one outcome worth a blind cancel.
DRAIN_ARMED=0

# The container is already swapped by this point, so a failure here is a
# failure with the new image LIVE. The message has to say so, or it reads as
# "nothing happened" — which is what the report said on 2026-09-23 while the
# new image was serving.
# 120s was the budget until 2026-09-24. It stopped being enough: the deploys of
# 426dc20c (23:46Z) and 65c2e438 (01:49Z) BOTH reported FAILED here and both had
# already swapped — 65c2e438 answered this endpoint fine once the deploy had
# given up on it, and is what the box has been serving since. Two consecutive
# false failures, on a report whose whole job is to say what is running.
#
# The number is a symptom, not the cause: every deploy up to 07b39255 (18:00Z)
# went healthy inside 120s, so something in the commits after it made the boot
# slower and nobody has measured what. Raised rather than diagnosed, and said so
# here — if this trips again, find what the boot spends its time on before
# raising it a second time.
HEALTH_WAIT=${HEALTH_WAIT:-420}
waited=0
last_health_error=""
while [ "$waited" -lt "$HEALTH_WAIT" ]; do
  if last_health_error=$(curl -fsS "$HEALTH_URL" 2>&1 >/dev/null); then break; fi
  sleep 2
  waited=$((waited + 2))
done
# curl's own words, not a guess: "connection refused" means still booting, an
# HTTP error means it booted and is unwell, and those want different next steps.
curl -fsS "$HEALTH_URL" >/dev/null 2>&1 ||
  die "swapped to $SHA, but it never became healthy at $HEALTH_URL within ${HEALTH_WAIT}s — the new image IS running (last error: ${last_health_error:-none reported})"
echo "healthy after ${waited}s"

# ── 7. Ask the running container which commit it IS ─────────────────────────
# The one question worth asking. Everything above can be green while the
# container still runs an older image.
step "7/7  Verify what is actually running"
RUNNING_SHA=$(docker compose exec -T "$SERVICE" cat /app/.deployed-sha 2>/dev/null | tr -d '\r\n' || true)
[ -n "$RUNNING_SHA" ] || die "the running image carries no SHA — it predates this script; re-run now that the Dockerfile records one"
[ "$RUNNING_SHA" = "$SHA" ] || die "running $RUNNING_SHA, expected $SHA"

# What came back of what step 5 parked, asked of the NEW server, which resumes
# parked work as it boots. Never fatal: the swap has happened and the new image is
# verified, so a report that cannot be read is said, not treated as a failure.
if [ -n "$PARK_DRAIN_ID" ]; then
  report_body=$(mktemp)
  park_report=""
  report_waited=0
  while :; do
    report_status=2
    report_code=$(drain_call GET '' "/park/$PARK_DRAIN_ID" "$report_body" 20 2>/dev/null) || report_code=""
    if [ "$report_code" = "200" ]; then
      report_status=0
      park_report=$(in_container "cd '$SOURCE_DIR' && bun scripts/drain-wait.ts --resume-report" <"$report_body") \
        || report_status=$?
    fi
    [ "$report_status" = "0" ] && break
    [ "$report_waited" -ge "$PARK_REPORT_WAIT" ] && break
    sleep 2
    report_waited=$((report_waited + 2))
  done
  rm -f "$report_body"
  case "$report_status" in
    0) ;;
    1) park_report="$park_report (not all of it resumed within ${PARK_REPORT_WAIT}s)" ;;
    *) park_report="parked work: the new server did not say what it resumed" ;;
  esac
  echo "$park_report"
  if [ -n "$PARK_REPORT_FILE" ]; then printf '%s\n' "$park_report" >"$PARK_REPORT_FILE"; fi
fi

printf '\n\033[32mDeployed %s\033[0m\n' "$SHA"
in_container "git -C '$DEPLOY_DIR' log --oneline -1"
