#!/usr/bin/env bash
#
# Ask the host to deploy this checkout's HEAD. Runs INSIDE the container.
#
# The container cannot deploy itself — no docker, no socket, no sudo — so it
# writes one file naming the commit it wants running, and a systemd .path unit
# on the host picks it up. See scripts/deploy-on-request.sh for the other half.
#
# Writes HEAD and never a SHA given on the command line. The request exists to
# say "the commit I just made", and a hand-typed SHA is the one thing that
# cannot be checked against what the asker actually meant.
#
# THIS SCRIPT DOES NOT SEE THE OUTCOME. It writes the request and returns; the
# host builds for minutes afterwards, then drains the server and swaps. So it
# prints where the outcome will be instead. Read /.archon/deploy-last.log
# afterwards, and /.archon/deploy-history for the verdict, which outlives it.
#
# The swap no longer ends the asking session, as long as that session is not
# mid-turn when it happens: a conversation's provider session id is persisted,
# so an open chat resumes with its context intact.
#
# THEN GO QUIET. THE CHAT THAT ASKS IS THE CHAT THAT BLOCKS.
#
# Drain stops the server ADMITTING work; it cannot end a turn already in flight,
# and it waits for every one of them. This conversation holds the conversation
# lock for the whole of each turn, so every message sent here — and every tool
# call an agent makes in reply — is one of the things the deploy is waiting for.
#
# That is not a theoretical risk. On 2026-09-25 an agent requested a deploy and
# then woke itself every twenty minutes to check on it. The drain log read
# `draining: 1 chat mid-turn` for 3116 seconds and the deploy failed; the chat
# holding it was the one that had asked. Requested again and left alone, the same
# commit reached `drained` on the first poll and was live in eleven minutes.
#
# So the contract is: ask, then say nothing to this chat until it is done.
# Progress cannot be reported from inside it, because reporting is a turn, and a
# turn is what the deploy is waiting to end. Silence is the mechanism working.
set -euo pipefail

VOLUME="${VOLUME:-/.archon}"
REQUEST="$VOLUME/deploy-request"
# Same defaults as deploy-local.sh, which pushes to the same place: the host
# pulls `$REMOTE_BRANCH` from the public fork, so both halves have to name it
# identically or the host fetches a branch nobody wrote to.
REMOTE="${REMOTE:-fork}"
REMOTE_BRANCH="${REMOTE_BRANCH:-deploy}"

SHA=$(git rev-parse HEAD)

# Who is asking, written as the request's second line (#211). A chat asking
# after a merge is `merge`, and the host deploys it only while the project's
# Deploy on Merge is on — otherwise it is recorded as HELD and nothing else
# happens. `manual <id>` is written only by the server's request-deploy-tip.sh, on behalf of
# a person who pressed Deploy now; the host checks the id with the server, so
# setting this by hand gets a request held, not deployed.
DEPLOY_SOURCE="${DEPLOY_SOURCE:-merge}"
case "$DEPLOY_SOURCE" in
  merge | manual\ *) ;;
  *)
    echo "DEPLOY_SOURCE must be 'merge' or 'manual <id>', not '$DEPLOY_SOURCE'" >&2
    exit 1
    ;;
esac

if [ -e "$REQUEST" ]; then
  echo "A request is already pending ($(cat "$REQUEST")) — the host has not consumed it yet." >&2
  exit 1
fi

DIRTY=$(git status --porcelain --untracked-files=no | wc -l | tr -d ' ')
if [ "$DIRTY" != "0" ]; then
  # A warning, not a failure: this checkout is shared, so "clean" is a state it
  # is never in, and most of those files belong to somebody else. The trap is
  # expecting an edit that was never committed to be in the deploy.
  echo "note: $DIRTY uncommitted file(s) — they will NOT be deployed"
fi

# THE INVARIANT: this commit is already on `dev`. Checked before the push, so a
# commit that only exists on `deploy` never reaches the remote at all — and
# before the request is written, so the host is never asked to build it.
#
# See scripts/assert-deploy-on-dev.sh for why `deploy` is a pointer and why
# there is no way to skip this.
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
"$script_dir/assert-deploy-on-dev.sh" "$SHA"

# THE PUSH BELONGS HERE, not in the host's deploy. This container is the half
# that holds GitHub credentials: the session's token is injected per call by the
# env-var store and is NOT in the container's own environment, so a push issued
# by the host through `docker compose exec` sees only the stale token the image
# was built with. Two deploys died there — one on a rotated token, one on no
# credential at all — while a working token sat in the asking session the whole
# time.
#
# The host needs none of this. The fork is public, so reading it and pulling
# from it authenticate against nothing.
#
# Tokens are tried by NAME, in order, and the first that authenticates wins.
# "A token is set" is not evidence: the container's GH_TOKEN has outlived its
# replacement once already, and returns 401 while looking perfectly present.
# The push itself is the only proof, so that is what decides.
remote_url=$(git remote get-url "$REMOTE") || exit 1
pushed=""
attempts=""

for var in GITHUB_PAT GH_TOKEN GITHUB_TOKEN; do
  token="${!var:-}"
  [ -n "$token" ] || continue
  url="https://x-access-token:${token}@${remote_url#https://}"
  # Output is redacted before it is shown: a failed push echoes the URL it
  # tried, and that URL carries the token.
  if out=$(GIT_TERMINAL_PROMPT=0 git push "$url" "HEAD:$REMOTE_BRANCH" 2>&1); then
    pushed="$var"
    break
  fi
  attempts="$attempts $var"
  last=$(printf '%s' "$out" | sed "s#${token}#<redacted>#g" | tail -1)
done

if [ -z "$pushed" ]; then
  # No request is written. A request naming a commit the host cannot fetch is a
  # deploy that fails four steps later for a reason recorded somewhere nobody
  # is looking.
  echo "Could not push to $REMOTE/$REMOTE_BRANCH. Tried:${attempts:- nothing — no token is set}" >&2
  [ -n "${last:-}" ] && echo "last error: $last" >&2
  exit 1
fi

echo "pushed $SHA to $REMOTE/$REMOTE_BRANCH (via $pushed)"

printf '%s\n%s\n' "$SHA" "$DEPLOY_SOURCE" >"$REQUEST"

echo "requested $SHA ($DEPLOY_SOURCE)"
if [ "$DEPLOY_SOURCE" = "merge" ]; then
  echo "If this project's Deploy on Merge is off, the host records it as HELD and"
  echo "deploys nothing; a person deploys it from the console with Deploy now."
fi
git log --oneline -1
echo
# Timings, not a promise. They are the shape of the thing rather than a
# prediction: printed because "no news" is otherwise indistinguishable from a
# deploy that died, and somebody watching had no way to tell which they had.
echo "The host builds now, then drains the server and swaps."
echo
echo "  ~1-3 min   build (cached layers make a repeat commit fast)"
echo "  then       drain: it waits for every chat mid-turn to finish"
echo "  ~2-3 min   swap, cold start, health check, verify the running SHA"
echo
echo "NOW LEAVE THIS CHAT ALONE. Every message here, and every tool call made in"
echo "reply, holds the conversation lock — and the drain is waiting for exactly"
echo "that to stop. A chat that keeps checking on its own deploy is the reason it"
echo "never lands."
echo
echo "Verdict:  tail -1 /.archon/deploy-history"
echo "Detail:   cat /.archon/deploy-last.log"
echo "No new deploy-history line within ~15 minutes of an idle box means it failed."
