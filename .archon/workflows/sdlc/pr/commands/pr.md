# Prepare the Pull Request

Prepare a clear, reviewer-friendly pull request for the committed work on the current branch. You never modify source files, and you never create, edit, or comment on the pull request yourself: your writes are the git push and the files below. The node that follows performs the one public write and verifies it, through whichever forge source this run selected.

Draft mode: **$INPUTS.draft** — `true` opens as a draft; anything else, ready for review. A pull request that already exists keeps the draft state its author gave it.

Context from the run that may narrow this (often empty):

$ARGUMENTS

## 1. Establish the target

The target is already resolved, deterministically, from this branch's own push configuration. Take it as given and never re-derive it:

- `HEAD_BRANCH` is **$INPUTS.head_branch** — the branch this run owns and the only one to push.
- `REPO_HOST` is **$INPUTS.repo_host** and `REPO_PATH` is **$INPUTS.repo_path** (`owner/repo`) — the repository this run publishes to. Use this same `REPO_PATH` for every `gh --repo` argument.
- `PUSH_REMOTE` is **$INPUTS.push_remote** — the remote name to push to.

Do not read `git remote get-url`, and do not consult the name `origin`: in a fork-style checkout `origin` is the upstream, and reading it would publish this diff against a repository the operator has no write access to and never chose. Never persist or print a credential-bearing raw remote URL; nothing above contains one and nothing you write should introduce one.

Determine the base branch from evidence, in order: the repository's documented development flow (steering files, CONTRIBUTING); branch ancestry against likely integration branches (`dev`, `development`, the remote default); an existing pull request for this exact branch. Never assume `main`. Use the same resolved base for every diff.

When this run was launched onto an existing pull request — the run's context names its number, and for a pull request from a fork the run sits on a review branch at that pull request's head — record that number and the qualified head repository it belongs to. Confirm `HEAD` descends from the recorded head revision. If the head lives in a fork and the author did not allow maintainer edits, this run cannot publish to it: stop and report, and do not prepare a replacement.

You do not look up whether this branch already has a pull request. The publishing node does that deterministically and never opens a second one.

## 2. Verify the work is ready

- Confirm the branch is not the base and has commits ahead of it. If intended work sits uncommitted, commit it first following the repository's conventions — staged by name, one coherent outcome per commit, human-sounding message, no AI attribution. Never sweep unrelated changes; if intended and unrelated changes cannot be separated safely, stop and say so.
- Read the complete merge-base diff — not just the file list — and confirm it matches the work described by the run's artifacts.

## 3. Write it

- Read the run's artifacts for content: `$ARTIFACTS_DIR/implementation.md` and anything else relevant under `$ARTIFACTS_DIR/`.
- Find the repository's PR template (`.github/pull_request_template.md` and its supported variants). Use it; fill every applicable section with concrete information and delete instructional comments. No template → problem first, then solution focused on behavior, then validation that actually ran.
- Title: concise, human, the meaningful outcome — never an implementation inventory.
- Link the issue with `Closes #N` only when the PR fully resolves it; `Relates to #N` otherwise. Never infer linkage from a bare number.
- Never add AI attribution, generated-by footers, or robot emoji.
- Check whether a gate passed red: read the typed-artifact listing at `$TYPED_ARTIFACTS_FILE`, take its `artifactsByType["green-gate"]` entries in the order the engine recorded them, and open each entry's `path` relative to `$ARTIFACTS_DIR` for that gate's JSON result. Any with a non-empty `red_cause` means this branch is being delivered while a project check is red. Add a short, plainly-titled section near the top of the body giving each such gate's `stage`, `red_cause`, and `summary`, and say that the PR's own CI is the check that still decides. Surface every listing `errors` entry and every gate body you cannot read as a caveat, never as "no gates". A reviewer must not have to discover this from a red badge.
- Write the complete body to `$ARTIFACTS_DIR/pr-body.md` — never inside the repository.

## 4. Push

Push the recorded branch with upstream tracking (`git push -u "$PUSH_REMOTE" "$HEAD_BRANCH"`). For an existing fork pull request whose author allowed maintainer edits, push to the fork instead, by explicit URL and ref (that is the contributor's repository, a different case from the publish target above, and it is unchanged): `git push "https://github.com/<headRepositoryOwner>/<headRepository>.git" "HEAD:refs/heads/<headRefName>"`. If the push is rejected or the remote diverged, stop and report — never rebase or force-push here. A remote branch already at your `HEAD` is a finished push — an interrupted earlier attempt of this step got that far — not an error; re-pushing it changes nothing.

## 5. Record the intent

Write `$ARTIFACTS_DIR/pr-intent.json` with exactly these fields:

- `repo`: `{ "host": REPO_HOST, "path": REPO_PATH }`, the repository the pull request opens against;
- `headRepo`: the same shape for the repository the head branch lives in — `repo` itself unless the head is in a fork;
- `head`: the recorded branch name, unqualified;
- `headRevision`: the full `HEAD` object id you pushed;
- `base`: the resolved base branch;
- `title`: the title you wrote;
- `bodyPath`: `$ARTIFACTS_DIR/pr-body.md`;
- `draft`: `true` or `false` as a JSON boolean, from `$INPUTS.draft`;
- `existing`: the pull request number this run was launched onto, as a JSON integer — omit this field entirely otherwise.

The file must contain no credential and no raw remote URL.

Also write `$ARTIFACTS_DIR/pr-action.md` with `REPO_HOST`, `REPO_PATH`, the recorded branch, the explicit push target, and the push result. This is the durable action evidence for what you did; the publishing node records what it did with the intent.

Return only `{"intent": "$ARTIFACTS_DIR/pr-intent.json"}` through the node's structured output.
