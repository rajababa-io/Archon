---
title: API Reference
description: REST API endpoints for programmatic access to Archon.
category: reference
area: server
audience: [developer]
sidebar:
  order: 6
---

Archon exposes a REST API via a [Hono](https://hono.dev/) server with OpenAPI spec generation. All endpoints are prefixed with `/api/`, except the host-only `/internal/*` surface -- see [Drain](#drain) -- which is unprefixed, authenticated, and must never be proxied.

## Base URL

By default, the API server runs at:

```
http://localhost:3090/api/
```

Override the port with the `PORT` environment variable or let Archon auto-allocate when running inside a worktree (range 3190-4089).

## OpenAPI Specification

A machine-readable OpenAPI 3.0 spec is available at:

```
GET /api/openapi.json
```

You can feed this into tools like Swagger UI or use it to generate typed API clients.

## Authentication

None. Archon is a single-developer tool -- there is no authentication on the API by default. If you expose Archon on a network, use a reverse proxy or firewall to restrict access. The `/internal/*` routes are the exception: they carry their own bearer token and only exist when it is configured.

---

## Health

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Basic health check |
| GET | `/api/health` | API-level health check |

```bash
curl http://localhost:3090/health
# {"status":"ok"}

curl http://localhost:3090/api/health
# {"status":"ok","adapter":"...","concurrency":{...},"runningWorkflows":0}
```

While the server is draining (see below), `/api/health` also carries a `drain` block
naming what is still held:

```json
{
  "drain": {
    "state": "draining",
    "requestedAt": "2026-09-23T19:00:00.000Z",
    "expiresAt": "2026-09-23T19:30:00.000Z",
    "refusedCount": 4,
    "parkAt": "2026-09-23T19:10:00.000Z",
    "holding": { "activeConversations": 1, "queuedMessages": 0, "runningWorkflows": 2 }
  }
}
```

`state` is `drained` only when all three `holding` counts are zero. `parkAt` is when the
deploy said it will park what is still running, present only when it said. The key is
absent entirely when the server is not draining.

---

## Drain

A deploy that recreates the container needs the server to be holding nothing at the
moment of the swap. Drain makes that moment instead of waiting for one: the server
stops admitting new conversation turns and workflow continuations, finishes what it
already holds, and reports `drain.state: "drained"` on `/api/health` once it holds
nothing. Drain by itself never cancels, fails, or abandons a run.

A message that arrives during drain is refused with `503` and a message the sender can
act on; it is never silently dropped. Messages already queued before drain began still
run.

Agent turns can run for tens of minutes, so waiting for everything to finish may never
end. A deploy can instead **park** what is still running: `POST /internal/drain/park`
interrupts each web chat's turn (the chat shows it was paused for a restart), saves the
messages queued behind it, and pauses each top-level workflow run this server executes.
Parked chats and runs stop counting toward `drain.holding`. Whatever cannot be parked --
chats on other platforms, runs another process owns, runs with a live sub-run -- is
listed in the answer as `blocked`, and the deploy keeps waiting for it.

Parked work is resumed by whichever server next runs without draining: the new server as
it boots, or this one when its drain is cancelled. Each parked chat receives one message
asking the agent to check what its interrupted step actually finished, then its queued
messages run in their original order, exactly once. Parked workflow runs continue from
the node that was in flight; completed nodes are not re-run. Only work recorded by the
park step is resumed -- a `running` row with no such record is never touched.

These endpoints exist only when `ARCHON_DRAIN_TOKEN` is set, and require it as a bearer
token. Like every `/internal/*` path they are host-only -- your reverse proxy must not
forward them.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/internal/drain` | Begin draining for `budgetSeconds` (1--3600); optional `graceSeconds` is reported back as `drain.parkAt` |
| DELETE | `/internal/drain` | Stop draining, hand back anything parked, and accept work again (idempotent) |
| POST | `/internal/drain/park` | Park what is still running; `409` when not draining |
| GET | `/internal/drain/park/{drainId}` | What one drain parked, and how much has resumed |
| GET | `/internal/deploy-policy` | The host's question before acting on a deploy request: answers `run` or `hold:<reason>` as plain text |

A `remote-host` project's host (see [Project deploy](#project-deploy)) presents its own
credential instead of the drain token. These two are registered on every install and
answer `401` to anything but a credential stored on a `remote-host` row:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/internal/remote-deploy/policy` (`source`, `sha`, `request` as for the host) | The same `run` / `hold:<reason>` answer, for the credential's own project |
| POST | `/internal/remote-deploy/report` | `{"verdict": "held" \| "ok" \| "failed", "sha", "live", "reason"?}`: what the host did with `sha`, and the commit it was running afterwards. `204` |

```bash
curl -X POST http://127.0.0.1:3090/internal/drain \
  -H "Authorization: Bearer $ARCHON_DRAIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"budgetSeconds": 1800}'
# {"requestedAt":"...","expiresAt":"...","refusedCount":0}

curl -X DELETE http://127.0.0.1:3090/internal/drain \
  -H "Authorization: Bearer $ARCHON_DRAIN_TOKEN"
# {"draining":false}

curl -X POST http://127.0.0.1:3090/internal/drain/park \
  -H "Authorization: Bearer $ARCHON_DRAIN_TOKEN"
# {"drainId":"...","parked":{"chats":3,"queuedMessages":1,"runs":1},
#  "blocked":[{"kind":"run","id":"...","reason":"not_owned_by_this_server"}]}
```

The budget is mandatory and lapses on its own, so a deploy that dies mid-drain cannot
leave a server refusing work forever. A deploy whose budget expires before the server
drains should deploy nothing and say so -- the box is still running what it was.

---

## Conversations

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/conversations` | List conversations |
| GET | `/api/conversations/{id}` | Get a single conversation |
| POST | `/api/conversations` | Create a new conversation |
| PATCH | `/api/conversations/{id}` | Update a conversation (rename) |
| DELETE | `/api/conversations/{id}` | Soft-delete a conversation |
| GET | `/api/conversations/{id}/lock` | Whether the conversation is executing a turn right now |
| GET | `/api/conversations/{id}/model` | The provider, model and effort the conversation's next turn runs on, and its own pin |
| PUT | `/api/conversations/{id}/model` | Pin the conversation's model and/or effort from its next turn (`null` for both clears) |
| GET | `/api/conversations/{id}/messages` | List messages in a conversation |
| POST | `/api/conversations/{id}/message` | Send a message to a conversation |

### List Conversations

```bash
curl http://localhost:3090/api/conversations
```

Query parameters:
- `codebaseId` (optional) -- Filter by codebase
- `platform` (optional) -- Filter by platform type (`web`, `slack`, ...)
- `mine` (optional) -- `true` narrows to the caller's own conversations when an
  identity resolves. Non-enforcing: with no identity it still lists everything.
- `archived` (optional) -- `active` (default), `archived`, or `all`
- `state` (optional) -- `open`, `done`, or `all` (default). Where the chat is in
  its lifecycle, which is a separate question from whether it was deleted.
- `limit` (optional) -- Rows to return, capped by the server

The response is an envelope, not a bare array:

```json
{
  "conversations": [{ "id": "...", "platform_conversation_id": "web-...", "...": "..." }],
  "counts": { "open": 3, "done": 112, "all": 115 }
}
```

`counts` applies every filter above **except** `state`, so one request reports
how many chats each lifecycle scope holds. Because the listing is capped,
comparing `counts` against the number of rows returned is how a client tells a
complete list from a truncated one.

### Create a Conversation

```bash
curl -X POST http://localhost:3090/api/conversations \
  -H "Content-Type: application/json" \
  -d '{}'
```

Optionally specify a codebase:

```bash
curl -X POST http://localhost:3090/api/conversations \
  -H "Content-Type: application/json" \
  -d '{"codebase_id": "your-codebase-id"}'
```

Returns the created conversation with its `platform_conversation_id`.

### Send a Message

```bash
curl -X POST http://localhost:3090/api/conversations/{id}/message \
  -H "Content-Type: application/json" \
  -d '{"message": "What does this codebase do?"}'
```

The message is dispatched to the orchestrator asynchronously. The response confirms dispatch -- actual AI responses arrive via SSE streaming or can be polled via the messages endpoint.

### Get Messages

```bash
curl http://localhost:3090/api/conversations/{id}/messages
```

Query parameters:
- `limit` (optional) -- Number of messages to return
- `before` (optional) -- Cursor for pagination

### Update a Conversation

```bash
curl -X PATCH http://localhost:3090/api/conversations/{id} \
  -H "Content-Type: application/json" \
  -d '{"title": "My feature discussion"}'
```

### Delete a Conversation

```bash
curl -X DELETE http://localhost:3090/api/conversations/{id}
```

Performs a soft delete -- the conversation is hidden but not destroyed.

---

## Codebases

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/codebases` | List registered codebases |
| GET | `/api/codebases/{id}` | Get a single codebase |
| POST | `/api/codebases` | Register a codebase (clone or local path) |
| DELETE | `/api/codebases/{id}` | Delete a codebase and clean up resources |
| GET | `/api/codebases/{id}/environments` | List isolation environments for a codebase |

### List Codebases

```bash
curl http://localhost:3090/api/codebases
```

### Register a Codebase

Clone from a URL:

```bash
curl -X POST http://localhost:3090/api/codebases \
  -H "Content-Type: application/json" \
  -d '{"url": "https://github.com/user/repo"}'
```

Register a local path:

```bash
curl -X POST http://localhost:3090/api/codebases \
  -H "Content-Type: application/json" \
  -d '{"path": "/home/user/projects/my-repo"}'
```

### Delete a Codebase

```bash
curl -X DELETE http://localhost:3090/api/codebases/{id}
```

Removes the codebase registration and cleans up associated worktrees and isolation environments.

### List Environments

```bash
curl http://localhost:3090/api/codebases/{id}/environments
```

Returns the isolation environments (worktrees) associated with a codebase.

---

## Workflows

### Definitions

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/workflows` | List available workflows |
| GET | `/api/workflows/{name}` | Get a single workflow definition |
| POST | `/api/workflows/validate` | Validate a workflow definition (in-memory, no save) |
| PUT | `/api/workflows/{name}` | Save (create or update) a workflow |
| DELETE | `/api/workflows/{name}` | Delete a user-defined workflow |

#### List Workflows

```bash
curl http://localhost:3090/api/workflows
```

Query parameters:
- `cwd` (optional) -- Working directory to discover project-specific workflows

When `cwd` is omitted, Archon returns bundled default workflows and any from `~/.archon/workflows/` (home-scoped). Project-specific workflows require either the `cwd` query param or a registered codebase, so the endpoint is useful on first launch before any project is registered.

Returns `{ workflows: [...], recommended: [...], errors?: [...] }`.

- `workflows[]` — each entry is `{ workflow, source, parseWarnings? }`. `parseWarnings` contains warning messages identifying the keys the engine silently dropped from that workflow's YAML, each with the node it was found on and what to write instead (see [Unknown keys](/guides/authoring-workflows/#unknown-keys-are-reported-not-rejected)); it is **omitted entirely** when the workflow is clean, so its presence alone is the signal.
- `recommended[]` — repo-owner-curated workflow names from `.archon/config.yaml`, filtered to discovered names and kept in declared order. Empty when there is no project context.
- `errors[]` — YAML parsing failures encountered during discovery. Unlike `parseWarnings`, these workflows did **not** load.

#### Get a Workflow

```bash
curl http://localhost:3090/api/workflows/archon-assist
```

Query parameters:
- `cwd` (optional) -- Working directory for project-specific lookup

Returns `{ workflow, filename, source: "project" | "global" | "bundled" }`. The endpoint auto-discovers across all three scopes in order (project → home-scoped → bundled). `source: "global"` is returned when the workflow comes from `~/.archon/workflows/`.

#### Validate a Workflow

```bash
curl -X POST http://localhost:3090/api/workflows/validate \
  -H "Content-Type: application/json" \
  -d '{"definition": {"name": "my-wf", "description": "Test", "nodes": [{"id": "a", "prompt": "hello"}]}}'
```

Returns `{ valid: true }` or `{ valid: false, errors: ["..."] }`. Does not save anything.

#### Save a Workflow

```bash
curl -X PUT http://localhost:3090/api/workflows/my-workflow \
  -H "Content-Type: application/json" \
  -d '{"definition": {"name": "my-workflow", "description": "My custom workflow", "nodes": [{"id": "plan", "prompt": "Plan the feature"}]}}'
```

Query parameters:
- `cwd` (optional) -- Target directory (must have `.archon/workflows/`)
- `source` (optional, enum: `project` \| `global`) -- Scope to write the workflow to. Defaults to `project` (writes to `<cwd>/.archon/workflows/`). Pass `source=global` to write to the home-scoped location (`~/.archon/workflows/`). Returns `400 "Invalid workflow source"` if any other value is supplied.

Validates the definition before saving. Returns the saved workflow.

#### Delete a Workflow

```bash
curl -X DELETE http://localhost:3090/api/workflows/my-workflow
```

Query parameters:
- `cwd` (optional) -- Target directory (must have `.archon/workflows/`)
- `source` (optional, enum: `project` \| `global`) -- Scope to delete from. Defaults to `project`. Pass `source=global` to delete from `~/.archon/workflows/`. Returns `400 "Invalid workflow source"` if any other value is supplied.

Only user-defined workflows can be deleted. Bundled defaults cannot be removed.

### Runs

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/workflows/{name}/run` | Run a workflow (JSON or multipart) |
| GET | `/api/workflows/runs` | List workflow runs |
| GET | `/api/workflows/runs/{runId}` | Get run details with events |
| GET | `/api/runs/{runId}/artifacts` | List artifact files produced by a run |
| GET | `/api/workflows/runs/by-worker/{platformId}` | Look up a run by worker conversation ID |
| POST | `/api/workflows/runs/{runId}/cancel` | Cancel a running workflow: a run this server executes stops at its next status check; a run another process owns has that owner stopped first. Returns **409** with the reason, and leaves the run unchanged, when no owner answers (abandon it once its process is gone) or the owner cannot be stopped; **400** for a run that is not running |
| POST | `/api/workflows/runs/{runId}/resume` | Resume a failed or paused workflow |
| POST | `/api/workflows/runs/{runId}/abandon` | Abandon a run (running, paused, or failed); stops a live detached owner first and cascade-cancels non-terminal `workflow:` sub-run descendants. Returns **409** with the reason, and leaves the run unchanged, when an owner answers but cannot be stopped |
| POST | `/api/workflows/runs/{runId}/approve` | Approve a paused workflow (400 if paused blocked on a `workflow:` child — approve the child) |
| POST | `/api/workflows/runs/{runId}/reject` | Reject a paused workflow (400 if paused blocked on a `workflow:` child — reject the child) |
| DELETE | `/api/workflows/runs/{runId}` | Delete a terminal run and its events |

Run responses expose `status` and `outcome` as separate fields. `status` is the execution
lifecycle. `outcome` is the workflow-authored verdict (`"succeeded"`, `"failed"`, or `null`) and
is never derived by the API from status or output text. Contradictory combinations are valid: for
example, `{"status":"completed","outcome":"failed"}` means execution finished but the workflow
rejected its result. `null` means no verdict has been authored, including undeclared and historical
runs. The list, detail, by-worker, and dashboard run endpoints preserve both fields.

#### Run a Workflow

```bash
# JSON (no attachments)
curl -X POST http://localhost:3090/api/workflows/archon-assist/run \
  -H "Content-Type: application/json" \
  -d '{"message": "Explain the auth module", "conversationId": "conv-123"}'

# multipart (with file attachments — max 5 files, ≤10 MB each)
curl -X POST http://localhost:3090/api/workflows/archon-assist/run \
  -F "conversationId=conv-123" \
  -F "message=Investigate this trace" \
  -F "files=@stacktrace.txt" \
  -F "files=@screenshot.png"
```

**Supplying declared inputs.** A workflow that declares [`inputs:`](/guides/authoring-workflows/#running-a-workflow-that-declares-inputs) takes their values through an optional `inputs` map — a flat object of string values. Omit a name to take its declared `default:`.

```bash
# JSON: inputs is a nested object
curl -X POST http://localhost:3090/api/workflows/review-block/run \
  -H "Content-Type: application/json" \
  -d '{"message": "review it", "conversationId": "conv-123",
       "inputs": {"diff": "...", "style": "terse"}}'

# multipart: form fields are strings, so the same map travels JSON-encoded
curl -X POST http://localhost:3090/api/workflows/review-block/run \
  -F "conversationId=conv-123" \
  -F "message=review it" \
  -F 'inputs={"diff":"...","style":"terse"}' \
  -F "files=@context.md"
```

Values are validated against the workflow's declaration before any worktree, clone, or AI cost: a missing **required** input and an **undeclared** name are both refused up front, through the same contract a composing `with:` map goes through. `400` if `inputs` is not an object of strings (or, on multipart, not valid JSON). An empty object is the same as omitting the field.

**Rebinding models for one run.** Optional `tiers` and `aliases` maps change only the named tier or existing `@alias` for this invocation. Every other binding keeps its normal user → repo → global → built-in value.

```bash
# JSON: only `large` changes
curl -X POST http://localhost:3090/api/workflows/issue-to-pr/run \
  -H "Content-Type: application/json" \
  -d '{"message":"fix #2481","conversationId":"conv-123",
       "tiers":{"large":"openai/gpt-5.6"},
       "aliases":{"@reviewer":"codex/gpt-5.6-sol"}}'

# multipart: each map is one JSON-encoded form field
curl -X POST http://localhost:3090/api/workflows/issue-to-pr/run \
  -F "conversationId=conv-123" \
  -F "message=fix #2481" \
  -F 'tiers={"large":"openai/gpt-5.6"}'
```

Tier keys are `small`, `medium`, and `large`; alias keys start with `@`. A model spec can name an Archon agent/model, a Pi vendor/model, an unqualified model under the binding's current provider, or another tier/alias preset. Literal model pins in the workflow remain unchanged. To replace all default tiers, author all three mappings explicitly. The run's `metadata.model_bindings` records the effective non-secret bindings for attribution and the sparse resolved overrides for reuse on resume.

**Loading inline config for one run.** Optional `config` content uses the same sparse runtime keys as a CLI run config file. JSON sends it as an object; multipart sends the object JSON-encoded in one form field. Explicit `tiers` and `aliases` fields are the final model layer and replace only matching names from `config`.

```bash
# JSON content
curl -X POST http://localhost:3090/api/workflows/issue-to-pr/run \
  -H "Content-Type: application/json" \
  -d '{"message":"fix #2482","conversationId":"conv-123",
       "config":{"tiers":{"large":{"provider":"pi","model":"minimax/MiniMax-M3"}},
                 "env":{"BENCH_MODE":"1"}},
       "tiers":{"large":"openai/gpt-5.6"}}'

# multipart content
curl -X POST http://localhost:3090/api/workflows/issue-to-pr/run \
  -F "conversationId=conv-123" \
  -F "message=fix #2482" \
  -F 'config={"docs":{"path":"handbook"},"workflows":{"quotaMaxAttempts":3}}'
```

Supported inline keys are `assistant` or `defaultAssistant`, `assistants`, `tiers`, `aliases`, `workflows`, `docs.path`, and `env`. Unknown or ineffective keys fail with `400` and name the key. `configPath` is always rejected: HTTP callers cannot ask the server to read a filesystem path. Run metadata stores sealed replay content plus redacted source/key attribution, and resume uses the original layer without accepting replacement content.

#### List Run Artifacts

```bash
curl http://localhost:3090/api/runs/{runId}/artifacts
```

Walks the run's on-disk artifact directory and returns `{ files: [{ path, size, modifiedAt }] }`. Used by the console UI's Artifacts tab. It leaves out only the engine's own `$ARTIFACTS_DIR/.archon/` child, the same rule `archon workflow get` applies, so a workflow's own dotfiles are listed. Returns 400 on an invalid run id or path-escape attempt, and 404 if the run does not exist or its output location cannot be resolved.

#### Resume a Failed or Paused Run

```bash
curl -X POST http://localhost:3090/api/workflows/runs/{runId}/resume
```

Resumes the workflow from where it left off, skipping already-completed nodes. Equivalent to `archon workflow resume <run-id>` from the CLI. Plain `archon workflow run <name>` invocations never resume implicitly.

#### Approve / Reject a Paused Run

```bash
# Approve (optionally with a comment)
curl -X POST http://localhost:3090/api/workflows/runs/{runId}/approve \
  -H "Content-Type: application/json" \
  -d '{"comment": "Looks good, proceed"}'

# Reject (optionally with a reason)
curl -X POST http://localhost:3090/api/workflows/runs/{runId}/reject \
  -H "Content-Type: application/json" \
  -d '{"reason": "Please add error handling first"}'
```

**Sub-run child gates (#2121 Phase 2):** when a `workflow:` sub-run pauses at its own gate, its parent run pauses "blocked on child". Approve/reject the **child** run (its id is in the parent's block message) — the parent auto-resumes when the child completes. A child gate is the exception: it works for a 1:1 sub-run, but a child that pauses inside a `fan_out:` expansion **fails the node** instead — a parent has one approval slot and cannot hand it to N children, so gate before or after the fan-out node rather than inside a child of it. Calling approve/reject on the *parent's* id while it is blocked on a child returns **400** with a redirect to the child id. `abandon` on a parent cascade-cancels its non-terminal sub-run descendants; the response's `cascadeFailures` is non-zero if part of the tree could not be reached, and `blockedParentRunId` is set when the abandoned run was itself a child stranding a paused parent.

---

## Commands

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/commands` | List available command names |

```bash
curl http://localhost:3090/api/commands
```

Query parameters:
- `cwd` (optional) -- Working directory for project-specific commands

Returns `{ commands: [{ name, source: "bundled" | "project" }] }`.

---

## Dashboard

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/dashboard/runs` | List enriched workflow runs for the dashboard |

Query parameters include status filters, date ranges, and pagination. Used by the Command Center UI.

Each run includes `active_nodes`, ordered by unresolved `node_started` event order. Completion,
failure, and both skip lifecycle events remove a node; `node_suspended` keeps it active; a retrying start adds it again. Concurrent
nodes remain separate entries. The compatibility fields `current_step_name` and
`current_step_status` are populated only when exactly one node is active, and are `null` for zero
or multiple active nodes. `total_steps` is `null`; observed lifecycle events do not define the
workflow's total node count. This state describes node lifecycle, not process-owner liveness.

---

## Push

Web Push for the mobile shell at `/m`. Push is off until `ARCHON_VAPID_PUBLIC`, `ARCHON_VAPID_PRIVATE` and `ARCHON_VAPID_SUBJECT` are set.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/push/vapid-key` | `{ enabled: true, publicKey }`, or `{ enabled: false, missing, problem }` naming what to set |
| POST | `/api/push/subscribe` | Store a browser's `PushSubscription` (its `toJSON()`); 503 while push is off |
| DELETE | `/api/push/subscribe` | Forget one, by `{ endpoint }` |
| GET | `/api/push/prefs` | `{ triggers: { awaiting, runFinished, runFailed }, mutedProjects, conversations }` |
| PUT | `/api/push/prefs` | One change: `{ scope: "global", triggers }`, `{ scope: "project", id, mode: "default" \| "muted" }`, or `{ scope: "conversation", id, mode: "default" \| "muted" \| "following" }` |
| POST | `/api/push/test` | Push a test notification to every subscribed browser |
| POST | `/api/push/presence` | `{ clientId, conversationId }` — the chat a console is showing (or `null`); no push is sent about a chat on screen |

A push is sent when a chat starts waiting on you (an unanswered ask block, or a run it started paused on a gate), when a run finishes or fails, and — for a chat set to `following` — when it finishes a turn. A muted chat or project sends nothing; `following` overrides the global triggers for that chat. A subscription the push service answers 404 or 410 for is deleted.

---

## Console views

The console tab each signed-in person last picked, so All projects and each project reopen on it from any device. The person is the email on a verified Cloudflare Access pass (`ARCHON_CF_ACCESS_TEAM_DOMAIN`, `ARCHON_CF_ACCESS_AUD`); without one both routes answer 401 and the console remembers the tab in the browser only.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/console/views` | `{ views }` — the caller's choices by scope id: `""` for All projects, otherwise a project id |
| PUT | `/api/console/views` | One choice: `{ scopeId, view }`, where `view` is `overview`, `runs`, `chat`, `issues` or `files` |

---

## Project pictures

The pictures a project has published, for the console's Overview Pictures band and gallery.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/projects/{projectId}/pictures` | `{ all, total, topics, pictures }`, newest first. Query: `limit` (1–200, default 8), `offset`, `topic`. Each picture has `url` (the original) and `thumbUrl` (a WebP at most 480px wide, or `null` when one could not be made) |

A picture belongs to the project whose name is its folder under `$ARCHON_HOME/public/`: project `archon` owns `public/archon/`, project `owner/repo` owns `public/owner/repo/`. A folder that is no project's name is listed for none. The first folder below that is the picture's topic. Thumbnails are written to `public/.thumbs/` on first listing and served by `/files/` like the originals; a compiled binary cannot load the image library, so there `thumbUrl` is always `null`.

---

## Configuration

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/config` | Get read-only configuration (safe subset) |
| PATCH | `/api/config/assistants` | Update the default assistant and per-provider model defaults |
| PATCH | `/api/config/tiers` | Update model-tier presets (`small`/`medium`/`large`) |
| PATCH | `/api/config/aliases` | Update `@custom` model aliases (per-key merge; `null` unsets) |
| GET | `/api/providers/pi/models` | Pi's model catalog (cost/reasoning metadata; best-effort, `[]` on failure) |

`GET /api/config` returns the safe config subset, now including the configured `tiers`, the built-in `tierDefaults` for the current default provider (what an unset tier resolves to), and the configured `aliases`.

These config routes are **ungated** -- they write non-secret model config to `~/.archon/config.yaml` and work on solo installs (no `TOKEN_ENCRYPTION_KEY` required). Contrast with the [AI Provider Credentials](#ai-provider-credentials) routes below, which require an identity.

A `PATCH` whose resulting config would be invalid is refused with `400` and nothing is written. The `error` field names the refused key, for example `Invalid assistants config: 'assistants.codex.modelReasoningEffort': ...`. This includes an invalid value already in the file that the patch leaves in place: fix that key (in the same request or by editing the file) before other changes save.

```bash
# Read current config (includes `tiers` + `tierDefaults`)
curl http://localhost:3090/api/config

# Set the default assistant
curl -X PATCH http://localhost:3090/api/config/assistants \
  -H "Content-Type: application/json" \
  -d '{"assistant": "claude"}'

# Or update per-provider model defaults
curl -X PATCH http://localhost:3090/api/config/assistants \
  -H "Content-Type: application/json" \
  -d '{"assistants": {"claude": {"model": "opus"}}}'

# Set a model tier (a `null` tier value unsets it, falling back to the built-in default)
curl -X PATCH http://localhost:3090/api/config/tiers \
  -H "Content-Type: application/json" \
  -d '{"tiers": {"large": {"provider": "claude", "model": "opus"}}}'

# Set a @custom alias (a `null` value unsets it)
curl -X PATCH http://localhost:3090/api/config/aliases \
  -H "Content-Type: application/json" \
  -d '{"aliases": {"@fast": {"provider": "claude", "model": "haiku"}}}'
```

---

## Per-User AI Preferences

Each user can override the install-wide model config with **personal** tiers, `@custom` aliases, and a default assistant — the highest-precedence resolver layer, applied to runs and chats *they* start. These routes require a resolved web identity (`X-Archon-User` header or a Better Auth session) but **no** `TOKEN_ENCRYPTION_KEY` — model names aren't secrets. Without an identity they return `401`, and model resolution stays config-only (solo installs are unchanged).

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/auth/me/ai-prefs` | The current user's stored prefs (raw layer, not merged) |
| PATCH | `/api/auth/me/ai-prefs/tiers` | Update personal tier presets (per-key merge; `null` unsets) |
| PATCH | `/api/auth/me/ai-prefs/aliases` | Update personal `@custom` aliases (per-key merge; `null` unsets) |
| PATCH | `/api/auth/me/ai-prefs/default` | Set (or clear with `null`) the personal default assistant + default chat model (`{ provider, model? }` — written atomically; an omitted `model` clears any pin, and `model` without a `provider` is rejected) |

```bash
# Point YOUR `large` tier at opus without touching the install config
curl -X PATCH http://localhost:3090/api/auth/me/ai-prefs/tiers \
  -H "X-Archon-User: your-user-id" \
  -H "Content-Type: application/json" \
  -d '{"tiers": {"large": {"provider": "claude", "model": "opus"}}}'
```

All writes validate the provider (registered), effort (provider vocabulary), and alias names (`@` prefix, not a reserved tier keyword), and return the updated prefs. The console exposes the same scopes as the **"This install / Just me"** toggle on AI Settings; the CLI as `archon ai … --scope user`.

---

## AI Provider Credentials

Per-user provider credentials let each user bill their runs and chats to **their own** API key or subscription instead of the shared install key. These endpoints require a resolved web identity (`X-Archon-User` header or a Better Auth session) — `GET /api/auth/providers` returns `401` without one. The encryption key is auto-provisioned on every install; `TOKEN_ENCRYPTION_KEY` is an optional override for managed deployments.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/auth/providers` | List the current user's connected credentials (metadata only) |
| PUT | `/api/auth/providers/{provider}` | Connect (upsert) an API key for a provider |
| DELETE | `/api/auth/providers/{provider}` | Disconnect a provider credential (idempotent) |
| POST | `/api/auth/providers/{provider}/oauth/start` | Begin a subscription (OAuth) login |
| POST | `/api/auth/providers/{provider}/oauth/poll` | Poll a subscription login session |

Credentials are encrypted at rest; **no endpoint ever returns a secret value** -- responses carry only `provider`/`kind`/`label` metadata.

### List Connected Providers

```bash
curl http://localhost:3090/api/auth/providers \
  -H "X-Archon-User: your-user-id"
```

Returns `{ enabled, connections: [{ provider, kind, label }], available, subscriptionAvailable, agents }`:
- `available` -- every **vendor** id you can connect an API key for (`anthropic`, `openai`, `github-copilot`, plus the Pi backends). Legacy `claude`/`codex`/`copilot` ids are accepted on writes and normalized.
- `subscriptionAvailable` -- the subset that supports subscription (OAuth) login: **`anthropic`**, **`openai`**, and **`github-copilot`**. (The ChatGPT/Codex subscription runs an Archon-owned PKCE flow that captures the `id_token` the Codex CLI requires -- see [#1924](https://github.com/coleam00/Archon/issues/1924).)
- `agents` -- the agent -> credential matrix: per registered agent `{ id, displayName, catalog: 'static'|'dynamic', ready, credentials: [{ vendor, displayName, kinds, connected, subscriptionAvailable, installEnv, ambientConfigured? }] }`. `installEnv`/`ambientConfigured` report server-side detection so readiness renders on solo installs too; OpenCode is `catalog:'dynamic'` (introspect via `GET /api/providers/opencode/credentials`).

### Connect an API Key

```bash
curl -X PUT http://localhost:3090/api/auth/providers/openrouter \
  -H "X-Archon-User: your-user-id" \
  -H "Content-Type: application/json" \
  -d '{"apiKey": "sk-...", "label": "personal"}'
```

Returns `{ success, provider, kind: "api_key", label }`. An unknown provider or a blank key returns `400`.

### Disconnect a Provider

```bash
curl -X DELETE http://localhost:3090/api/auth/providers/openrouter \
  -H "X-Archon-User: your-user-id"
```

Idempotent -- disconnecting a provider that was never connected still returns `{ success: true }`.

### Subscription Login (OAuth)

Subscription login is a two-step `start` -> `poll` flow held server-side. `start` returns a `mode`:
- `manual` (`anthropic`, Claude Pro/Max) -- show the returned `url`; the user authorizes in a browser and pastes the resulting code back via `poll`.
- `device` (`github-copilot`) -- show `userCode` + `verificationUri`; `poll` until connected.

```bash
# 1. Start a login session
curl -X POST http://localhost:3090/api/auth/providers/anthropic/oauth/start \
  -H "X-Archon-User: your-user-id"
# {"sessionId":"...","mode":"manual","url":"https://...","expiresIn":600}

# 2. Poll (pass the pasted `code` once, for manual flows)
curl -X POST http://localhost:3090/api/auth/providers/anthropic/oauth/poll \
  -H "X-Archon-User: your-user-id" \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "...", "code": "the-pasted-code"}'
# {"status":"connected"}
```

`poll` returns `{ status: "pending" | "connected" | "error", detail? }`. A provider that does not support subscription login returns `400` on `start`.

The CLI equivalent of this whole surface is [`archon ai`](/reference/cli/#ai). For the end-to-end setup walkthrough, see [Per-user credentials and AI Settings](/getting-started/ai-assistants/#per-user-credentials-and-ai-settings).

---

## System

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/update-check` | Check for available updates (binary builds only) |

Returns `{ updateAvailable, currentVersion, latestVersion, releaseUrl }`. For non-binary (source) builds, always returns `updateAvailable: false` without making external requests.

---

## SSE Streaming

| Path | Description |
|------|-------------|
| `/api/stream/{conversationId}` | Real-time events for a conversation |
| `/api/stream/__dashboard__` | Multiplexed workflow events across all conversations |

These are Server-Sent Events (SSE) endpoints -- connect with `EventSource` in a browser or any SSE client.

```bash
# Listen to a conversation stream
curl -N http://localhost:3090/api/stream/your-conversation-id
```

Events are JSON-encoded with a `type` field. See the [Web UI documentation](/adapters/web/#sse-streaming) for the full list of event types.

---

## Common Patterns

### Create a Conversation and Send a Message

```bash
# 1. Create a conversation
CONV_ID=$(curl -s -X POST http://localhost:3090/api/conversations \
  -H "Content-Type: application/json" \
  -d '{}' | jq -r '.platform_conversation_id')

# 2. Send a message
curl -X POST http://localhost:3090/api/conversations/$CONV_ID/message \
  -H "Content-Type: application/json" \
  -d '{"message": "/status"}'

# 3. Poll for messages
curl http://localhost:3090/api/conversations/$CONV_ID/messages
```

### Run a Workflow via the API

```bash
# 1. Create a conversation scoped to a codebase
CONV_ID=$(curl -s -X POST http://localhost:3090/api/conversations \
  -H "Content-Type: application/json" \
  -d '{"codebase_id": "your-codebase-id"}' | jq -r '.platform_conversation_id')

# 2. Start the workflow
curl -X POST http://localhost:3090/api/workflows/archon-assist/run \
  -H "Content-Type: application/json" \
  -d "{\"message\": \"How does auth work?\", \"conversationId\": \"$CONV_ID\"}"

# 3. Monitor via SSE
curl -N http://localhost:3090/api/stream/$CONV_ID
```

---

## Project deploy

Every project has a deploy bar in the console header. A project with a deploy shows what
is live, the merged PRs not yet live, a **Deploy on Merge** switch, **Deploy now**, and
**Cancel deploy**. A project without one shows **Deploys: not set up** and a **Set up
deploys** button.

A project deploys one of three ways, named by its `method`:

- `workflow` -- the project's own repository deploys it with an Archon workflow
  (usually `.archon/workflows/deploy.yaml`). Deploy now runs that workflow on a checkout
  cut from the branch tip; with Deploy on Merge on, a pull request merged into the branch
  does the same. What is live is the commit of the newest deploy run that completed --
  unless the deploy names a **production branch**: a project that deploys by merging
  into that branch, through its own CI rather than Archon, reads what is live as that
  branch's tip, and what is waiting as the merged PRs on the working branch that the tip
  does not yet contain. The bar then reads `main → production`, and a production branch
  GitHub does not have reports `waitingReason: "no-production-branch"`. Starting a run needs `ARCHON_TRIGGER_HOST` on the server (see
  [workflow triggers](/guides/workflow-triggers/)); without it Deploy now is refused.
  Merges arrive through the GitHub webhook at `/webhooks/github`, so only repositories
  whose webhook points at this install deploy on merge.
- `archon-host` -- this install deploying itself through the host's request file. No
  route creates it. Its branch must be the one merges land on (`dev` here), never the
  `deploy` pointer the host moves: a row naming `deploy` reports
  `waitingReason: "branch-is-deploy-pointer"` and Deploy now is refused.
- `remote-host` -- another host pulls the branch and deploys itself, and asks this
  install first. Before each deploy it calls `GET /internal/remote-deploy/policy`, and
  afterwards it reports what it did to `POST /internal/remote-deploy/report`. What is
  live is the commit its newest report says it was running; before its first report the
  bar says `waitingReason: "live-unknown"`. Deploy now posts `{"sha", "request"}` to the
  row's `remote_url`; the host then asks the policy as `manual` with that `request`, so
  reaching that address can at most make the host ask. Cancel deploy is refused: the
  host's deploy is not this install's to stop. No route creates the row; the host's
  credential is stored only as its SHA-256 in `remote_token_sha256`, and it names the
  project, so a host can ask and report about its own project and no other.

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| GET | `/api/projects/{projectId}/deploy` | any | The deploy bar and whether this request could act (`canAct`). With no deploy: `{"deploy": null, "setup": {"branch", "workflows", "workflow"}, "canAct"}`, the picker's defaults |
| PUT | `/api/projects/{projectId}/deploy` | person | Set up deploys: `{"branch": "main", "productionBranch"?: "production", "workflowName": "deploy"}`. Creates a `workflow` deploy with Deploy on Merge off and deploys nothing; `400` for a workflow the project does not have or a production branch equal to `branch`, `409` if it already has a deploy |
| PATCH | `/api/projects/{projectId}/deploy` | person | `{"deployOnMerge": true \| false}` |
| PATCH | `/api/projects/{projectId}/deploy/settings` | person | The bar's settings: `{"branch", "productionBranch", "workflowName"}`; an empty `productionBranch` clears it. Only a `workflow` deploy takes a production branch or a workflow; an `archon-host` deploy is refused its own `deploy` pointer |
| GET | `/api/projects/{projectId}/deploy/branches` | any | `{"branches", "defaultBranch", "complete", "reason"}`: the GitHub repository's branches, default first, for the pickers. `complete` is false past the first 100; `reason` says why the list is empty when GitHub could not be read |
| POST | `/api/projects/{projectId}/deploy` | person | Deploy now: `{"sha": "<the waiting tip>"}`; `409` if a deploy is already running, the branch has moved, or (for `workflow`) the workflow is missing |
| DELETE | `/api/projects/{projectId}/deploy` | person | Cancel deploy: for `archon-host`, `409` once the swap has started; for `workflow`, cancels this project's running deploy run |
| GET | `/api/projects/{projectId}/deploy/log` | any | Toggle flips, Deploy now, Cancel, and how each deploy went, newest first. A merge that should have started a `workflow` deploy and did not is a `not_started` entry, with the merged PR as `actor` and the reason as `detail` |

**Person** means a request carrying a Cloudflare Access login pass
(`Cf-Access-Jwt-Assertion`) that verifies against `ARCHON_CF_ACCESS_TEAM_DOMAIN` and
`ARCHON_CF_ACCESS_AUD`. Anything else -- including every agent, which can reach the
server directly -- gets `403`. With those two settings unset, every person-only action is
refused.

A workflow deploy runs as the Archon user of the person who pressed Deploy now; a merge
deploy runs as the person who last set Deploy on Merge.

A chat that runs `scripts/request-deploy.sh` asks as `merge`: the host deploys it only
while Deploy on Merge is on, and otherwise records it in `deploy-history` as `HELD`.
Deploy now asks as `manual`, with an id the server checks before the host acts.
