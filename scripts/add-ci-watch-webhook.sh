#!/usr/bin/env bash
# Subscribe repositories' check_run events to Archon's GitHub webhook, so a chat
# that called `watch_ci` hears when CI finishes.
#
#   WEBHOOK_SECRET=... scripts/add-ci-watch-webhook.sh <payload-url> <owner/repo>...
#
#   payload-url  Archon's public URL plus /webhooks/github
#   WEBHOOK_SECRET  the same secret the server runs with; GitHub signs every
#                   delivery with it and the server rejects anything else
#
# Idempotent. A repository that already has a webhook to that URL gets check_run
# added to its events (its secret is left alone — it already matches, or the
# server was rejecting it all along); one with no such webhook gets a new one
# subscribed to check_run only. Needs `gh` authenticated with admin on each
# repository. Changes GitHub settings, so it is run by the operator, not by CI.
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: WEBHOOK_SECRET=... $0 <payload-url> <owner/repo>..." >&2
  exit 2
fi
: "${WEBHOOK_SECRET:?WEBHOOK_SECRET must be set to the secret the server runs with}"

url=$1
shift
case "$url" in
  https://*/webhooks/github) ;;
  *)
    echo "payload URL must be https://.../webhooks/github, got: $url" >&2
    exit 2
    ;;
esac

for repo in "$@"; do
  hook_id=$(gh api "repos/$repo/hooks" --paginate \
    --jq ".[] | select(.config.url == \"$url\") | .id" | head -n 1)

  if [ -z "$hook_id" ]; then
    gh api "repos/$repo/hooks" --method POST --silent \
      -f "config[url]=$url" \
      -f "config[content_type]=json" \
      -f "config[secret]=$WEBHOOK_SECRET" \
      -f "events[]=check_run"
    echo "$repo: created webhook (check_run)"
    continue
  fi

  has_check_run=$(gh api "repos/$repo/hooks/$hook_id" --jq 'any(.events[]; . == "check_run" or . == "*")')
  if [ "$has_check_run" = "true" ]; then
    echo "$repo: webhook $hook_id already receives check_run"
  else
    gh api "repos/$repo/hooks/$hook_id" --method PATCH --silent -f "add_events[]=check_run"
    echo "$repo: added check_run to webhook $hook_id"
  fi
done
