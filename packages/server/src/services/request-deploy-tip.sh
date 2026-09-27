#!/usr/bin/env bash
#
# Deploy now, on behalf of a person in the console (#211). Runs INSIDE the
# container, started by the server's human-verified Deploy now route.
#
# What is waiting to deploy is everything merged into the dev branch since the
# live commit, so what Deploy now ships is the dev branch's tip. The host deploys
# from a checkout that has the requested commit checked out, and pushes nothing
# the asker did not; so this puts the tip into a checkout of its own and asks
# from there, through the same request-deploy.sh a chat uses — the same
# on-dev check, the same push to the deploy branch, the same request file.
#
# The one difference is the request's second line: `manual <id>`, where <id> is
# the event the server recorded when the person pressed the button. The host
# asks the server whether it issued that id for this commit before it acts, so
# this script run by anyone else gets its request held, not deployed.
#
# Inputs, from the server:
#   SOURCE_DIR         the project's checkout; the deploy checkout is a worktree of it
#   EXPECT_SHA         the tip the person was shown. If dev has moved since, this
#                      refuses rather than shipping commits nobody looked at.
#   DEPLOY_REQUEST_ID  the id the server issued
#
# Exit 3 means dev moved; anything else non-zero is a failure with the reason on
# stderr.
set -euo pipefail

: "${SOURCE_DIR:?SOURCE_DIR is required}"
: "${EXPECT_SHA:?EXPECT_SHA is required}"
: "${DEPLOY_REQUEST_ID:?DEPLOY_REQUEST_ID is required}"

VOLUME="${VOLUME:-/.archon}"
# Same defaults as request-deploy.sh and assert-deploy-on-dev.sh, which this
# hands over to: the remote the deploy branch is pushed to, and the branch that
# work merges into.
REMOTE="${REMOTE:-fork}"
DEV_BRANCH="${DEV_BRANCH:-dev}"
# On the data volume, beside the other deploy files: it has to outlive the
# request by the whole build, and the host finds it through `git worktree list`.
WORKTREE="${DEPLOY_WORKTREE:-$VOLUME/deploy-checkout}"

git -C "$SOURCE_DIR" fetch --quiet "$REMOTE" \
  "+refs/heads/$DEV_BRANCH:refs/remotes/$REMOTE/$DEV_BRANCH"
tip=$(git -C "$SOURCE_DIR" rev-parse "refs/remotes/$REMOTE/$DEV_BRANCH")

if [ "$tip" != "$EXPECT_SHA" ]; then
  echo "$DEV_BRANCH has moved to $tip since you looked (you saw $EXPECT_SHA) — nothing was requested" >&2
  exit 3
fi

if git -C "$WORKTREE" rev-parse --git-dir >/dev/null 2>&1; then
  git -C "$WORKTREE" checkout --quiet --detach "$tip"
else
  # A directory left behind by a worktree git no longer knows about would make
  # `worktree add` fail; prune forgets it first.
  git -C "$SOURCE_DIR" worktree prune
  git -C "$SOURCE_DIR" worktree add --quiet --detach "$WORKTREE" "$tip"
fi

cd "$WORKTREE"
VOLUME="$VOLUME" REMOTE="$REMOTE" DEPLOY_SOURCE="manual $DEPLOY_REQUEST_ID" \
  bash scripts/request-deploy.sh
