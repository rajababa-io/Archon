-- Remote Coding Agent - Combined Schema
-- Version: Combined (final state after migrations 001-020)
-- Description: Complete database schema (idempotent - safe to run multiple times)
--
-- Layout (load-bearing, not cosmetic — see the final section for why):
--   * CREATE TABLE and ALTER TABLE ... ADD COLUMN come first, in feature order.
--   * Everything that NAMES A COLUMN — every CREATE INDEX, every
--     COMMENT ON COLUMN — goes in the final "Indexes and column comments"
--     section, below every ADD COLUMN.
--
-- Tables (+ the remote_agent_auth_* Better Auth tables, listed inline below):
--   1. remote_agent_codebases
--   1b. remote_agent_codebase_env_vars
--   1c. remote_agent_users
--   1d. remote_agent_user_identities
--   2. remote_agent_conversations
--   3. remote_agent_sessions
--   4. remote_agent_isolation_environments
--   5. remote_agent_workflow_runs
--   6. remote_agent_workflow_events
--   6b. remote_agent_workflow_node_sessions
--   7. remote_agent_messages
--   7b. remote_agent_ci_watches
--   8. remote_agent_user_github_tokens
--   9. remote_agent_user_provider_keys
--   10. remote_agent_user_ai_prefs
--   11. remote_agent_parked_work
--   12. remote_agent_project_deploy
--   13. remote_agent_deploy_events
--   14. remote_agent_deploy_runs
--   15. remote_agent_push_subscriptions
--   16. remote_agent_notify_prefs
--   17. remote_agent_deploy_not_started
--   18. remote_agent_deploy_reports
--   19. remote_agent_shares
--
-- Dropped tables (via migrations):
--   - remote_agent_command_templates (017)
--
-- Dropped columns (via migrations):
--   - conversations.worktree_path (007)
--   - conversations.isolation_env_id_legacy (007)
--   - conversations.isolation_provider (007)

-- ============================================================================
-- Table 1: Codebases
-- ============================================================================

CREATE TABLE IF NOT EXISTS remote_agent_codebases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  repository_url VARCHAR(500),
  default_cwd VARCHAR(500) NOT NULL,
  default_branch VARCHAR(255),
  ai_assistant_type VARCHAR(20) DEFAULT 'claude',
  kind VARCHAR(10) NOT NULL DEFAULT 'repo' CHECK (kind IN ('repo', 'folder')),
  allow_env_keys BOOLEAN NOT NULL DEFAULT FALSE,
  commands JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

COMMENT ON TABLE remote_agent_codebases IS
  'Repository metadata: name, URL, working directory, default branch, AI assistant type, and command paths (JSONB)';

-- ============================================================================
-- Table 1b: Codebase Env Vars
-- ============================================================================

CREATE TABLE IF NOT EXISTS remote_agent_codebase_env_vars (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codebase_id UUID NOT NULL REFERENCES remote_agent_codebases(id) ON DELETE CASCADE,
  key VARCHAR(255) NOT NULL,
  value TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(codebase_id, key)
);

COMMENT ON TABLE remote_agent_codebase_env_vars IS
  'Per-project env vars merged into Options.env on Claude SDK calls. Managed via Web UI or config.';

-- ============================================================================
-- Table 1c: Users (Archon identity, platform-agnostic)
-- ============================================================================

CREATE TABLE IF NOT EXISTS remote_agent_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name VARCHAR(255),
  email VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE remote_agent_users IS
  'Archon-internal user identity. Created on first sight by any adapter; populated via per-platform user-info lookups.';

-- ============================================================================
-- Table 1d: User Identities (per-platform mapping → users.id)
-- ============================================================================

CREATE TABLE IF NOT EXISTS remote_agent_user_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES remote_agent_users(id) ON DELETE CASCADE,
  platform VARCHAR(32) NOT NULL,
  platform_user_id VARCHAR(255) NOT NULL,
  platform_display_name VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(platform, platform_user_id)
);

COMMENT ON TABLE remote_agent_user_identities IS
  'Maps platform-native user IDs (Slack U-ids, Telegram chat ids, GitHub logins, Discord snowflakes) to Archon user UUIDs.';

-- ============================================================================
-- Table 2: Conversations
-- ============================================================================

CREATE TABLE IF NOT EXISTS remote_agent_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_type VARCHAR(20) NOT NULL,
  platform_conversation_id VARCHAR(255) NOT NULL,
  codebase_id UUID REFERENCES remote_agent_codebases(id) ON DELETE SET NULL,
  cwd VARCHAR(500),
  ai_assistant_type VARCHAR(20) DEFAULT 'claude',
  isolation_env_id UUID,  -- FK added after isolation_environments table exists
  title VARCHAR(255),
  color VARCHAR(20),
  deleted_at TIMESTAMP WITH TIME ZONE,
  hidden BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  last_activity_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(platform_type, platform_conversation_id)
);

-- ============================================================================
-- Table 3: Sessions
-- ============================================================================

CREATE TABLE IF NOT EXISTS remote_agent_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES remote_agent_conversations(id) ON DELETE CASCADE,
  codebase_id UUID REFERENCES remote_agent_codebases(id) ON DELETE SET NULL,
  ai_assistant_type VARCHAR(20) NOT NULL,
  assistant_session_id VARCHAR(255),
  active BOOLEAN DEFAULT true,
  metadata JSONB DEFAULT '{}'::jsonb,
  parent_session_id UUID REFERENCES remote_agent_sessions(id),
  transition_reason TEXT,
  ended_reason TEXT,
  started_at TIMESTAMP DEFAULT NOW(),
  ended_at TIMESTAMP
);

-- ============================================================================
-- Table 4: Isolation Environments
-- ============================================================================

CREATE TABLE IF NOT EXISTS remote_agent_isolation_environments (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codebase_id           UUID NOT NULL REFERENCES remote_agent_codebases(id) ON DELETE CASCADE,

  -- Workflow identification (what work this is for)
  workflow_type         TEXT NOT NULL,        -- 'issue', 'pr', 'review', 'thread', 'task'
  workflow_id           TEXT NOT NULL,        -- '42', 'pr-99', 'thread-abc123'

  -- Implementation details
  provider              TEXT NOT NULL DEFAULT 'worktree',
  working_path          TEXT NOT NULL,        -- Actual filesystem path
  branch_name           TEXT NOT NULL,        -- Git branch name

  -- Lifecycle
  status                TEXT NOT NULL DEFAULT 'active',  -- 'active', 'destroyed'
  created_at            TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_by_platform   TEXT,                 -- 'github', 'slack', etc.

  -- Cross-reference metadata (for linking)
  metadata              JSONB DEFAULT '{}'
);

-- Add FK from conversations to isolation_environments (deferred to avoid circular dependency)
ALTER TABLE remote_agent_conversations
  ADD COLUMN IF NOT EXISTS isolation_env_id UUID
    REFERENCES remote_agent_isolation_environments(id) ON DELETE SET NULL;

COMMENT ON TABLE remote_agent_isolation_environments IS
  'Work-centric isolated environments with independent lifecycle';

-- ============================================================================
-- Table 5: Workflow Runs
-- ============================================================================

CREATE TABLE IF NOT EXISTS remote_agent_workflow_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_name VARCHAR(255) NOT NULL,
  conversation_id UUID REFERENCES remote_agent_conversations(id) ON DELETE CASCADE,
  codebase_id UUID REFERENCES remote_agent_codebases(id) ON DELETE SET NULL,
  current_step_index INTEGER,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending, running, completed, failed, cancelled, paused
  outcome VARCHAR(20) CHECK (outcome IN ('succeeded', 'failed')),
  user_message TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  parent_conversation_id UUID REFERENCES remote_agent_conversations(id) ON DELETE SET NULL,
  parent_run_id UUID REFERENCES remote_agent_workflow_runs(id) ON DELETE SET NULL,
  adopted_from_run_id UUID REFERENCES remote_agent_workflow_runs(id) ON DELETE SET NULL,
  started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE,
  last_activity_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  working_path TEXT,
  output_root TEXT,
  checkout_baseline JSONB
);

COMMENT ON TABLE remote_agent_workflow_runs IS
  'Tracks workflow execution state for resumption and observability';

-- ============================================================================
-- Table 6: Workflow Events
-- ============================================================================

CREATE TABLE IF NOT EXISTS remote_agent_workflow_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id UUID NOT NULL REFERENCES remote_agent_workflow_runs(id) ON DELETE CASCADE,
  event_order BIGINT,
  event_type VARCHAR(50) NOT NULL,
  step_index INTEGER,
  step_name VARCHAR(255),
  data JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE remote_agent_workflow_events IS
  'Lean UI-relevant workflow events for observability (step transitions, artifacts, errors)';

-- ============================================================================
-- Workflow run node sessions (private same-run session lineage)
-- ============================================================================

CREATE TABLE IF NOT EXISTS remote_agent_workflow_run_node_sessions (
  workflow_run_id UUID NOT NULL REFERENCES remote_agent_workflow_runs(id) ON DELETE CASCADE,
  node_id VARCHAR(255) NOT NULL,
  provider VARCHAR(50) NOT NULL,
  provider_session_id TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  PRIMARY KEY (workflow_run_id, node_id)
);

COMMENT ON TABLE remote_agent_workflow_run_node_sessions IS
  'Private provider session handles produced by top-level nodes within one workflow run. Cascades with the owning run and is never exposed through run or event APIs.';

-- ============================================================================
-- Workflow node sessions (persist_session opt-in across re-runs)
-- ============================================================================

CREATE TABLE IF NOT EXISTS remote_agent_workflow_node_sessions (
  workflow_name VARCHAR(255) NOT NULL,
  node_id VARCHAR(255) NOT NULL,
  scope_key TEXT NOT NULL,
  provider VARCHAR(50) NOT NULL,
  provider_session_id TEXT NOT NULL,
  last_run_id UUID REFERENCES remote_agent_workflow_runs(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  PRIMARY KEY (workflow_name, node_id, scope_key, provider)
);

COMMENT ON TABLE remote_agent_workflow_node_sessions IS
  'Per-node provider session IDs persisted across workflow re-runs. Keyed by (workflow, node, scope, provider). Scope is typically conversation UUID. No cascade on conversation delete (soft delete + never-reused UUID = harmless orphans); a future hard-delete path must delete by scope_key.';

-- ============================================================================
-- Table 7: Messages
-- ============================================================================

CREATE TABLE IF NOT EXISTS remote_agent_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES remote_agent_conversations(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================================================
-- Table 7b: CI Watches (migration 035)
-- ============================================================================
--
-- A chat's standing request to hear when CI finishes on one commit. A row
-- because the request has to outlive the turn that made it; keyed by head SHA
-- because "CI finished" is a question about every check on that commit, not
-- about the one `check_run` event that happened to arrive. open -> fired is a
-- compare-and-set, so a webhook and the reconcile sweep cannot both fire it.

CREATE TABLE IF NOT EXISTS remote_agent_ci_watches (
  id UUID PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES remote_agent_conversations(id) ON DELETE CASCADE,
  repo TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  pull_request INTEGER,
  status VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'fired', 'cancelled')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  settled_at TIMESTAMP WITH TIME ZONE
);

-- ============================================================================
-- Cleanup: Drop legacy objects from older schemas
-- ============================================================================

-- Drop command_templates table (replaced by file-based commands in .archon/commands)
DROP TABLE IF EXISTS remote_agent_command_templates;
DROP INDEX IF EXISTS idx_remote_agent_command_templates_name;

-- Drop legacy columns from conversations (if upgrading from older schema)
ALTER TABLE remote_agent_conversations DROP COLUMN IF EXISTS worktree_path;
ALTER TABLE remote_agent_conversations DROP COLUMN IF EXISTS isolation_env_id_legacy;
ALTER TABLE remote_agent_conversations DROP COLUMN IF EXISTS isolation_provider;
DROP INDEX IF EXISTS idx_conversations_isolation;

-- Drop legacy constraint from isolation_environments (if upgrading from older schema)
ALTER TABLE remote_agent_isolation_environments
  DROP CONSTRAINT IF EXISTS unique_workflow;

-- ============================================================================
-- Idempotent ALTER statements for upgrading existing databases
-- (These are no-ops on fresh installs since columns exist in CREATE TABLE above)
-- ============================================================================

-- From migration 006: isolation_env_id + last_activity_at on conversations
ALTER TABLE remote_agent_conversations
  ADD COLUMN IF NOT EXISTS isolation_env_id UUID
    REFERENCES remote_agent_isolation_environments(id) ON DELETE SET NULL;
ALTER TABLE remote_agent_conversations
  ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

-- From migration 009: last_activity_at on workflow_runs
ALTER TABLE remote_agent_workflow_runs
  ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

-- From migration 010: parent_session_id + transition_reason on sessions
ALTER TABLE remote_agent_sessions
  ADD COLUMN IF NOT EXISTS parent_session_id UUID REFERENCES remote_agent_sessions(id);
ALTER TABLE remote_agent_sessions
  ADD COLUMN IF NOT EXISTS transition_reason TEXT;

-- From migration 013: title + deleted_at on conversations
ALTER TABLE remote_agent_conversations
  ADD COLUMN IF NOT EXISTS title VARCHAR(255);
ALTER TABLE remote_agent_conversations
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE;

-- User-chosen color label on a conversation (visual only; never interpreted).
ALTER TABLE remote_agent_conversations
  ADD COLUMN IF NOT EXISTS color VARCHAR(20);

-- Agent-maintained summary of the chat, when it was last written, and whether a
-- human edited it (which stops the agent overwriting it unasked).

-- From migration 015: parent_conversation_id + hidden
ALTER TABLE remote_agent_workflow_runs
  ADD COLUMN IF NOT EXISTS parent_conversation_id UUID
    REFERENCES remote_agent_conversations(id) ON DELETE SET NULL;
ALTER TABLE remote_agent_conversations
  ADD COLUMN IF NOT EXISTS hidden BOOLEAN DEFAULT FALSE;

-- From migration 016: ended_reason on sessions
ALTER TABLE remote_agent_sessions
  ADD COLUMN IF NOT EXISTS ended_reason TEXT;

-- From migration 021: allow_env_keys on codebases
ALTER TABLE remote_agent_codebases
  ADD COLUMN IF NOT EXISTS allow_env_keys BOOLEAN NOT NULL DEFAULT FALSE;

-- From migration 023: detected default branch on codebases
ALTER TABLE remote_agent_codebases
  ADD COLUMN IF NOT EXISTS default_branch VARCHAR(255);

-- From migration 024: project kind discriminator ('repo' | 'folder').
-- Folder projects are non-git workspaces (multi-repo roots or plain ops folders)
-- that run in place with named artifact/log storage under _folder/<slug>/.
ALTER TABLE remote_agent_codebases
  ADD COLUMN IF NOT EXISTS kind VARCHAR(10) NOT NULL DEFAULT 'repo';

-- From migration 027: the console's per-project presentation (icon, colour,
-- brief) as one opaque blob, and the hand-arranged rail position. sort_order is
-- its own column because the rail is ordered in SQL.
ALTER TABLE remote_agent_codebases
  ADD COLUMN IF NOT EXISTS presentation JSONB;
ALTER TABLE remote_agent_codebases
  ADD COLUMN IF NOT EXISTS sort_order INTEGER;

-- From migration 028: hand-arranged position of a chat in the console rail.
ALTER TABLE remote_agent_conversations
  ADD COLUMN IF NOT EXISTS sort_order INTEGER;

-- From migration 029: a human named this chat, so automatic re-titling skips it.
ALTER TABLE remote_agent_conversations
  ADD COLUMN IF NOT EXISTS title_pinned BOOLEAN DEFAULT FALSE;

-- From migration 033: when a human last read this chat to the end, and every
-- chat that predates the column is treated as already read.
--
-- Unread is `last_activity_at > last_read_at`, and the marker is what makes
-- that rule survivable at all: "the newest message is the agent's" was built
-- and removed twice (see primitives/chat-status.ts), because every finished
-- chat ends with the agent, so the rail went amber forever and `idle` became
-- unreachable. Reading a chat clears the mark; without this column the signal
-- could only ever turn on.
--
-- THE GUARD IS LOAD-BEARING, for the same reason it is on 032 above. This file
-- is re-executed on EVERY boot, so a standing UPDATE would mark every chat read
-- on every restart and silently delete the feature. Running the backfill only
-- in the boot that ADDS the column makes it a one-time reading of history.
--
-- And the backfill has to happen: every existing row answers "never read" for
-- want of anywhere to record the answer, not because nobody read it. Left
-- alone, the first boot after the upgrade paints the whole history amber —
-- exactly the failure this column exists to prevent, on day one.
--
-- Rows created after keep NULL until someone reads them, which is correct: a
-- new chat that has spoken and never been opened is unread.
DO $migration_033$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'remote_agent_conversations' AND column_name = 'last_read_at'
  ) THEN
    ALTER TABLE remote_agent_conversations ADD COLUMN last_read_at TIMESTAMP WITH TIME ZONE;
    UPDATE remote_agent_conversations
    SET last_read_at = last_activity_at
    WHERE last_activity_at IS NOT NULL;
  END IF;
END
$migration_033$;

-- From migration 034: the agent's claim that this chat's work is finished,
-- pending a human's judgement.
--
-- `completed_at` below is the HUMAN's answer; this is the agent's, and the two
-- are deliberately separate columns because they are different assertions by
-- different parties. Between them sits the state the rail could not express:
-- nothing is running, and someone should decide.
--
-- No guard and no backfill, unlike 033 above, and the asymmetry is the point:
-- there the default was wrong for history, so every old row had to be corrected
-- before the first boot painted the rail amber. Here NULL is the OFF state and
-- is truthful for every row that predates the column — no agent ever declared
-- those finished, because there was no way to. A plain ADD COLUMN IF NOT EXISTS
-- is therefore the whole migration, and re-running it on every boot changes
-- nothing.
ALTER TABLE remote_agent_conversations
  ADD COLUMN IF NOT EXISTS ready_at TIMESTAMP WITH TIME ZONE;

-- From migration 036: the model and effort one chat runs on, chosen inside it.
-- The provider is recorded with the pin because a model id only means
-- something on the provider it was chosen for; a turn on another provider
-- ignores the pin. NULL throughout means no pin, which is true of every row
-- that predates the columns, so there is nothing to backfill.
ALTER TABLE remote_agent_conversations
  ADD COLUMN IF NOT EXISTS pinned_provider VARCHAR(64);
ALTER TABLE remote_agent_conversations
  ADD COLUMN IF NOT EXISTS pinned_model VARCHAR(255);
ALTER TABLE remote_agent_conversations
  ADD COLUMN IF NOT EXISTS pinned_effort VARCHAR(16);

-- From migrations 031 and 032: the chat's unit of work is finished, and every
-- chat archived before the column existed becomes a finished one.
--
-- A chat is one issue, or one cluster of them; `completed_at` is when a human
-- said that work had landed. NULL means not finished, which is every row's
-- default and the only answer an older binary can give.
--
-- The backfill is the other half. Archiving and marking done were two flags
-- over one idea -- get this out of the list -- and the console now has a single
-- lifecycle and does not list soft-deleted rows at all, so an archived chat
-- left as it was would be visible nowhere. Reading "you filed it away" as "you
-- were finished with it" is the only reading that cannot lose a chat;
-- reopening one is a single click.
--
-- THE GUARD IS LOAD-BEARING, and this is why the pair is a DO block rather than
-- the ADD COLUMN IF NOT EXISTS above it plus a bare UPDATE. This file is
-- re-executed on EVERY boot. A standing `WHERE deleted_at IS NOT NULL` is not a
-- migration, it is a rule that runs forever -- and `deleted_at` is still
-- written by the DELETE route and the PATCH `archived` field, so the next
-- restart would resurrect a chat the operator had just deleted and mark it
-- done. Running the backfill only in the boot that ADDS the column makes it
-- what it claims to be: a one-time reading of history. It also matches the
-- SQLite adapter, where the same pair sits inside the same guard.
DO $migration_032$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'remote_agent_conversations' AND column_name = 'completed_at'
  ) THEN
    ALTER TABLE remote_agent_conversations ADD COLUMN completed_at TIMESTAMPTZ;
    UPDATE remote_agent_conversations
    SET completed_at = deleted_at,
        deleted_at = NULL
    WHERE deleted_at IS NOT NULL;
  END IF;
END
$migration_032$;

-- From migration 030: every title that predates the column is treated as one a
-- human chose, because nothing was recording the answer when it was written.
-- Idempotent; leaves untitled rows (the hidden workflow sub-chats) alone.
UPDATE remote_agent_conversations
SET title_pinned = TRUE
WHERE title IS NOT NULL
  AND title <> ''
  AND title_pinned IS NOT TRUE;

-- User identity foreign keys (nullable on the four primary tables).
-- All FKs use ON DELETE SET NULL so future user deletion never cascades destructively.
ALTER TABLE remote_agent_conversations
  ADD COLUMN IF NOT EXISTS user_id UUID
    REFERENCES remote_agent_users(id) ON DELETE SET NULL;
ALTER TABLE remote_agent_messages
  ADD COLUMN IF NOT EXISTS user_id UUID
    REFERENCES remote_agent_users(id) ON DELETE SET NULL;
ALTER TABLE remote_agent_workflow_runs
  ADD COLUMN IF NOT EXISTS user_id UUID
    REFERENCES remote_agent_users(id) ON DELETE SET NULL;
ALTER TABLE remote_agent_isolation_environments
  ADD COLUMN IF NOT EXISTS created_by_user_id UUID
    REFERENCES remote_agent_users(id) ON DELETE SET NULL;

-- Run-tree parent (#2121 Phase 2): a `workflow:` sub-run links back to the run
-- that spawned it. Self-referential FK, ON DELETE SET NULL so deleting a parent
-- orphans children rather than cascade-deleting their audit trail. First
-- self-referential FK on this table — declared identically on SQLite (sqlite.ts).
ALTER TABLE remote_agent_workflow_runs
  ADD COLUMN IF NOT EXISTS parent_run_id UUID
    REFERENCES remote_agent_workflow_runs(id) ON DELETE SET NULL;

-- Durable output root (#2200): the resolved `~/.archon/workspaces/<project>/`
-- directory this run's artifacts, logs, and state live under, written once at
-- run start. Readers prefer it and only re-derive from codebase identity when
-- it is NULL (pre-existing rows), so historical artifacts stay addressable
-- across a codebase rename (#1192). Declared identically on SQLite (sqlite.ts).
ALTER TABLE remote_agent_workflow_runs
  ADD COLUMN IF NOT EXISTS output_root TEXT;

-- Run checkout baseline (#3305): the checkout observation taken once when the run
-- won its execution claim, before its first node. Write-once; NULL means not
-- recorded (runs from before the column, or runs that never started). Declared
-- identically on SQLite (sqlite.ts) as TEXT holding the same JSON.
ALTER TABLE remote_agent_workflow_runs
  ADD COLUMN IF NOT EXISTS checkout_baseline JSONB;

-- Between-run continuation (#2747): the terminal run whose estate (worktree/
-- branch + artifacts-by-reference) this run explicitly adopted. Mirrors
-- `parent_run_id` exactly — nullable, self-referential, SET NULL — and like it
-- is written once at run creation, never on resume. Reverse lookup (`adopted_by`)
-- reads the same column; no second column. Declared identically on SQLite.
ALTER TABLE remote_agent_workflow_runs
  ADD COLUMN IF NOT EXISTS adopted_from_run_id UUID
    REFERENCES remote_agent_workflow_runs(id) ON DELETE SET NULL;

-- Authored workflow verdict (#2618), independent from lifecycle status. Nullable
-- means undeclared or not yet authored; no default/backfill so historical rows
-- remain unknown rather than being reinterpreted from current workflow YAML.
ALTER TABLE remote_agent_workflow_runs
  ADD COLUMN IF NOT EXISTS outcome VARCHAR(20)
    CHECK (outcome IN ('succeeded', 'failed'));

-- From PR-C: per-user GitHub user-to-server tokens (device flow), encrypted at rest.
-- One row per Archon user; cascades on user deletion. github_user_id is the
-- numeric anchor for the commit no-reply email (survives username changes).
CREATE TABLE IF NOT EXISTS remote_agent_user_github_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES remote_agent_users(id) ON DELETE CASCADE,
  github_user_id BIGINT NOT NULL,
  github_login VARCHAR(255) NOT NULL,
  access_token_encrypted TEXT NOT NULL,
  refresh_token_encrypted TEXT,
  access_token_expires_at TIMESTAMP WITH TIME ZONE,
  refresh_token_expires_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id)
);

-- Phase 2: per-user AI-provider credentials (BYO API key + subscription login),
-- encrypted at rest with the existing token-crypto key. One row per
-- (user_id, provider); cascades on user deletion. Exactly one of
-- api_key_encrypted / oauth_creds_encrypted is populated per row; `kind`
-- records which. Gated on TOKEN_ENCRYPTION_KEY at the application layer.
CREATE TABLE IF NOT EXISTS remote_agent_user_provider_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES remote_agent_users(id) ON DELETE CASCADE,
  provider VARCHAR(64) NOT NULL,
  kind VARCHAR(16) NOT NULL,
  api_key_encrypted TEXT,
  oauth_creds_encrypted TEXT,
  label VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, provider)
);

-- #1955: credential rows are vendor-keyed (claude→anthropic, codex→openai,
-- copilot→github-copilot) so one credential can serve every agent that
-- consumes the vendor. Idempotent data fix: where both a legacy and a vendor
-- row exist for the same user, the vendor row wins (rare — requires having
-- connected both ids pre-rename); then legacy rows are renamed in place.
-- Tested on SQLite (adapters/sqlite.test.ts covers rename, conflict, and
-- idempotency); the Postgres DML below is the same statements but is NOT
-- covered by an automated test — verified manually on the multi-user smoke.
-- Survivable either way: reads normalize legacy ids (normalizeCredentialVendor).
DELETE FROM remote_agent_user_provider_keys
WHERE provider IN ('claude', 'codex', 'copilot')
  AND EXISTS (
    SELECT 1 FROM remote_agent_user_provider_keys v
    WHERE v.user_id = remote_agent_user_provider_keys.user_id
      AND v.provider = CASE remote_agent_user_provider_keys.provider
        WHEN 'claude' THEN 'anthropic'
        WHEN 'codex' THEN 'openai'
        WHEN 'copilot' THEN 'github-copilot'
      END
  );
UPDATE remote_agent_user_provider_keys SET provider = 'anthropic' WHERE provider = 'claude';
UPDATE remote_agent_user_provider_keys SET provider = 'openai' WHERE provider = 'codex';
UPDATE remote_agent_user_provider_keys SET provider = 'github-copilot' WHERE provider = 'copilot';

-- Phase 3: per-user AI preferences (model tiers, @custom aliases, default
-- assistant). NON-encrypted — model names are not secrets (mirrors
-- codebase_env_vars, not the provider-key store). One row per user; cascades
-- on user deletion. `tiers` / `aliases` are JSON-as-TEXT (parsed in the
-- store layer so SQLite and Postgres behave identically).
CREATE TABLE IF NOT EXISTS remote_agent_user_ai_prefs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES remote_agent_users(id) ON DELETE CASCADE,
  tiers TEXT,
  aliases TEXT,
  default_provider VARCHAR(64),
  default_model VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id)
);

-- #1998: per-user default CHAT model, written atomically with
-- default_provider (a model pin is only meaningful for the provider it was
-- set with). Idempotent upgrade for installs that created the table before
-- this column existed.
ALTER TABLE remote_agent_user_ai_prefs
  ADD COLUMN IF NOT EXISTS default_model VARCHAR(255);

-- ============================================================================
-- Web auth (opt-in): role on the canonical user + Better Auth tables
-- ============================================================================
--
-- `role` is the durable identity seam: everyone defaults to 'admin' for now;
-- 'member' is reserved for future per-resource scoping. Visibility stays open.
ALTER TABLE remote_agent_users
  ADD COLUMN IF NOT EXISTS role VARCHAR(16) NOT NULL DEFAULT 'admin';

-- Lifecycle ordering (#2359 follow-up): timestamps can tie, especially on
-- SQLite (one-second precision), so a database-assigned order breaks the tie and
-- preserves event chronology. `id` cannot serve this role — it is a random UUID,
-- not monotonic.
--
-- Deliberately a plain column plus a sequence DEFAULT, NOT `GENERATED ... AS
-- IDENTITY`. Adding an identity column REWRITES the whole table under ACCESS
-- EXCLUSIVE (verified on postgres:18: relfilenode changes), and this is the
-- largest table in the schema while the schema auto-applies on startup — that is
-- a boot-time stall proportional to event history. ADD COLUMN with no default is
-- metadata-only, and SET DEFAULT afterwards applies to future inserts only.
--
-- It also keeps both databases honest: existing rows stay NULL on Postgres AND
-- SQLite, so the COALESCE(event_order, 0) fallback in read queries behaves
-- identically. An identity column would have back-filled Postgres rows (1, 2,
-- 3...) while SQLite left them NULL.
ALTER TABLE remote_agent_workflow_events
  ADD COLUMN IF NOT EXISTS event_order BIGINT;
CREATE SEQUENCE IF NOT EXISTS remote_agent_workflow_events_event_order_seq
  OWNED BY remote_agent_workflow_events.event_order;
ALTER TABLE remote_agent_workflow_events
  ALTER COLUMN event_order SET DEFAULT nextval('remote_agent_workflow_events_event_order_seq');

-- ============================================================================
-- Schema vintage (#2316)
-- ============================================================================
--
-- Which Archon build created this database, and which last applied schema to it.
-- Diagnostic only — nothing gates, refuses, or warns on these values. Single row
-- (id = 1); the row's VALUES are written by the adapters from APP_VERSION
-- (packages/core/src/db/schema-version.ts) so the version string has exactly one
-- source of truth. created_app_version is NULL for databases that predate this
-- table and is never back-filled with a guess.
CREATE TABLE IF NOT EXISTS remote_agent_schema_version (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  created_app_version VARCHAR(64),
  app_version VARCHAR(64) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS remote_agent_start_receipts (
  id UUID PRIMARY KEY,
  source_instance_id TEXT NOT NULL,
  delivery_id TEXT,
  content_digest TEXT NOT NULL,
  received_at TIMESTAMP WITH TIME ZONE NOT NULL,
  occurred_at TIMESTAMP WITH TIME ZONE,
  source_actor TEXT,
  outcome VARCHAR(20) NOT NULL CHECK (outcome IN ('matched', 'unmatched', 'unsupported', 'malformed')),
  reason TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE(source_instance_id, delivery_id)
);

CREATE TABLE IF NOT EXISTS remote_agent_start_receipt_bindings (
  receipt_id UUID NOT NULL REFERENCES remote_agent_start_receipts(id) ON DELETE CASCADE,
  binding_id TEXT NOT NULL,
  binding_revision TEXT,
  host_id TEXT,
  intent TEXT,
  preparation_status VARCHAR(20) NOT NULL CHECK (preparation_status IN ('pending', 'preparing', 'failed', 'rejected', 'unmatched', 'complete')),
  preparation_owner TEXT,
  preparation_error TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  PRIMARY KEY (receipt_id, binding_id)
);

CREATE TABLE IF NOT EXISTS remote_agent_resource_slots (
  resource_key TEXT PRIMARY KEY,
  capacity INTEGER NOT NULL DEFAULT 1 CHECK (capacity >= 1),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS remote_agent_resource_slot_holders (
  resource_key TEXT NOT NULL REFERENCES remote_agent_resource_slots(resource_key),
  holder_kind VARCHAR(10) NOT NULL CHECK (holder_kind IN ('run', 'attempt')),
  holder_id TEXT NOT NULL,
  acquired_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  -- The owner process of an 'attempt' holder; NULL for 'run' holders.
  owner_host TEXT,
  owner_pid INTEGER,
  owner_instance TEXT,
  PRIMARY KEY (resource_key, holder_kind, holder_id)
);

CREATE TABLE IF NOT EXISTS remote_agent_resource_start_requests (
  id UUID PRIMARY KEY,
  queue_position BIGSERIAL NOT NULL UNIQUE,
  resource_key TEXT NOT NULL REFERENCES remote_agent_resource_slots(resource_key),
  host_id TEXT NOT NULL,
  overlap_policy VARCHAR(10) NOT NULL CHECK (overlap_policy IN ('skip', 'queue')),
  status VARCHAR(12) NOT NULL CHECK (status IN ('queued', 'admitted', 'skipped', 'withdrawn')),
  blocker_run_id UUID,
  blocker_kind VARCHAR(10) CHECK (blocker_kind IN ('run', 'request')),
  launch TEXT NOT NULL,
  receipt_id UUID,
  binding_id TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  admitted_at TIMESTAMP WITH TIME ZONE,
  FOREIGN KEY (receipt_id, binding_id) REFERENCES remote_agent_start_receipt_bindings(receipt_id, binding_id) ON DELETE SET NULL
);

-- Work a deploy parked so it could replace the container (#144). Written only by
-- the drain park step; a resuming server replays exactly these rows and nothing
-- else, which is what keeps it from touching an ambiguous `running` row. An older
-- binary ignores the table, so parked work waits for a current binary — it is
-- delayed, never corrupted. See migrations/037_deploy_parked_work.sql.
CREATE TABLE IF NOT EXISTS remote_agent_parked_work (
  id UUID PRIMARY KEY,
  drain_id UUID NOT NULL,
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('chat_resume', 'queued_message', 'workflow_run')),
  conversation_id UUID REFERENCES remote_agent_conversations(id) ON DELETE CASCADE,
  run_id UUID REFERENCES remote_agent_workflow_runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL DEFAULT '',
  attached_files JSONB,
  user_id TEXT,
  parked_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  resumed_at TIMESTAMP WITH TIME ZONE
);

COMMENT ON TABLE remote_agent_parked_work IS
  'Chat turns, queued messages and workflow runs a deploy stopped before replacing the container. resumed_at is set exactly once, by whichever process claims the row to resume it.';

-- How a project deploys, and whether merges deploy on their own (#211). No row
-- means the project has no deploy. See migrations/038_project_deploy.sql.
CREATE TABLE IF NOT EXISTS remote_agent_project_deploy (
  codebase_id UUID PRIMARY KEY REFERENCES remote_agent_codebases(id) ON DELETE CASCADE,
  method VARCHAR(32) NOT NULL,
  branch VARCHAR(255) NOT NULL,
  deploy_on_merge BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_by TEXT
);

COMMENT ON TABLE remote_agent_project_deploy IS
  'How a project deploys and whether merges deploy on their own. No row means the project has no deploy. deploy_on_merge is changed only by a person in the console.';

CREATE TABLE IF NOT EXISTS remote_agent_deploy_events (
  id UUID PRIMARY KEY,
  codebase_id UUID NOT NULL REFERENCES remote_agent_codebases(id) ON DELETE CASCADE,
  kind VARCHAR(32) NOT NULL CHECK (kind IN ('toggle_on', 'toggle_off', 'deploy_requested', 'deploy_cancelled')),
  actor TEXT,
  sha VARCHAR(64),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE remote_agent_deploy_events IS
  'Deploy actions a person took in the console: toggle flips, Deploy now, Cancel deploy. A deploy_requested id is the token the host checks before honouring a manual request.';

-- A project deploys by running a workflow in its own repository (#226). See
-- migrations/039_project_deploy_workflow.sql.
ALTER TABLE remote_agent_project_deploy
  ADD COLUMN IF NOT EXISTS workflow_name VARCHAR(255);

CREATE TABLE IF NOT EXISTS remote_agent_deploy_runs (
  run_id UUID PRIMARY KEY REFERENCES remote_agent_workflow_runs(id) ON DELETE CASCADE,
  codebase_id UUID NOT NULL REFERENCES remote_agent_codebases(id) ON DELETE CASCADE,
  sha VARCHAR(64) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE remote_agent_deploy_runs IS
  'Workflow runs that were a project''s deploy, with the commit each was asked to ship. Live is the newest one whose run completed.';

-- Web Push for the phone: browser subscriptions and what to be told about.
-- See migrations/040_push_notifications.sql.
CREATE TABLE IF NOT EXISTS remote_agent_push_subscriptions (
  id UUID PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  last_success_at TIMESTAMP WITH TIME ZONE
);

COMMENT ON TABLE remote_agent_push_subscriptions IS
  'Browsers that asked for Web Push. Deleted when the push service answers 404 or 410.';

CREATE TABLE IF NOT EXISTS remote_agent_notify_prefs (
  scope VARCHAR(16) NOT NULL CHECK (scope IN ('global', 'project', 'conversation')),
  scope_id TEXT NOT NULL,
  mode VARCHAR(16) NOT NULL DEFAULT 'default' CHECK (mode IN ('default', 'muted', 'following')),
  notify_awaiting BOOLEAN,
  notify_run_finished BOOLEAN,
  notify_run_failed BOOLEAN,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  PRIMARY KEY (scope, scope_id)
);

COMMENT ON TABLE remote_agent_notify_prefs IS
  'Push preferences: per-chat default/muted/following, per-project mute, and the global triggers.';

-- A merge that should have started a project's deploy and did not (#236). See
-- migrations/041_deploy_not_started.sql.
CREATE TABLE IF NOT EXISTS remote_agent_deploy_not_started (
  id UUID PRIMARY KEY,
  codebase_id UUID NOT NULL REFERENCES remote_agent_codebases(id) ON DELETE CASCADE,
  sha VARCHAR(64) NOT NULL,
  trigger_ref TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE remote_agent_deploy_not_started IS
  'Merges that should have started a project''s deploy and did not, with the reason. Read into the project''s deploy log.';

-- The console tab each signed-in person last picked (#251). See
-- migrations/042_console_view_prefs.sql.
CREATE TABLE IF NOT EXISTS remote_agent_console_view_prefs (
  person TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  view VARCHAR(16) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  PRIMARY KEY (person, scope_id)
);

COMMENT ON TABLE remote_agent_console_view_prefs IS
  'Last console tab per signed-in person: All projects (scope_id empty) and each project.';

-- The branch production runs from, for a project deploying outside Archon
-- (#265, #266). See migrations/044_project_deploy_production_branch.sql.
ALTER TABLE remote_agent_project_deploy
  ADD COLUMN IF NOT EXISTS production_branch VARCHAR(255);

-- A project that deploys itself on another host and asks Archon first (#220).
-- See migrations/043_project_deploy_remote.sql.
ALTER TABLE remote_agent_project_deploy
  ADD COLUMN IF NOT EXISTS remote_url TEXT;
ALTER TABLE remote_agent_project_deploy
  ADD COLUMN IF NOT EXISTS remote_token_sha256 VARCHAR(64);

CREATE TABLE IF NOT EXISTS remote_agent_deploy_reports (
  id UUID PRIMARY KEY,
  codebase_id UUID NOT NULL REFERENCES remote_agent_codebases(id) ON DELETE CASCADE,
  verdict VARCHAR(16) NOT NULL,
  sha VARCHAR(64) NOT NULL,
  live_sha VARCHAR(64) NOT NULL,
  reason TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE remote_agent_deploy_reports IS
  'What a remote-host deploy reported doing: held, ok or failed, with the commit it was running afterwards.';

-- Share links (#345). See migrations/045_shares.sql.
CREATE TABLE IF NOT EXISTS remote_agent_shares (
  code VARCHAR(32) PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  access VARCHAR(16) NOT NULL DEFAULT 'link' CHECK (access IN ('link', 'restricted')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE remote_agent_shares IS
  'Published pages and files reachable at /share/<code>/ without a login, while access is link.';

-- Provider-attempt holders on the shared resource slot (#2816): owner process
-- columns, and the holder-kind CHECK widened from ('run'). Unreleased dev databases
-- created the narrow CHECK; re-adding the named constraint converges them. Every
-- existing row is a 'run' holder, so the new constraint always validates.
ALTER TABLE remote_agent_resource_slot_holders
  ADD COLUMN IF NOT EXISTS owner_host TEXT;
ALTER TABLE remote_agent_resource_slot_holders
  ADD COLUMN IF NOT EXISTS owner_pid INTEGER;
ALTER TABLE remote_agent_resource_slot_holders
  ADD COLUMN IF NOT EXISTS owner_instance TEXT;
ALTER TABLE remote_agent_resource_slot_holders
  DROP CONSTRAINT IF EXISTS remote_agent_resource_slot_holders_holder_kind_check;
ALTER TABLE remote_agent_resource_slot_holders
  ADD CONSTRAINT remote_agent_resource_slot_holders_holder_kind_check
    CHECK (holder_kind IN ('run', 'attempt'));

COMMENT ON TABLE remote_agent_schema_version IS
  'Diagnostic schema vintage: the Archon build that created this database and the one that last applied schema to it.';

-- Better Auth tables (PostgreSQL only). Generated by `@better-auth/cli generate`
-- against packages/server/src/auth/instance.ts (modelName-renamed to the
-- `remote_agent_auth_*` prefix), then made idempotent with IF NOT EXISTS so the
-- bundled-schema auto-apply on startup converges. Better Auth owns these tables
-- and the column shape (text ids, camelCase columns) — Archon never queries them
-- directly; a session is mapped to the canonical remote_agent_users row via
-- user_identities('web', <betterAuthUserId>). Always created on Postgres (the
-- IF NOT EXISTS apply runs on every boot); populated only when web auth is
-- enabled (BETTER_AUTH_SECRET + DATABASE_URL), harmless empty tables otherwise.
CREATE TABLE IF NOT EXISTS remote_agent_auth_user (
  "id" text NOT NULL PRIMARY KEY,
  "name" text NOT NULL,
  "email" text NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL,
  "image" text,
  "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS remote_agent_auth_session (
  "id" text NOT NULL PRIMARY KEY,
  "expiresAt" timestamptz NOT NULL,
  "token" text NOT NULL UNIQUE,
  "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamptz NOT NULL,
  "ipAddress" text,
  "userAgent" text,
  "userId" text NOT NULL REFERENCES remote_agent_auth_user ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS remote_agent_auth_account (
  "id" text NOT NULL PRIMARY KEY,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES remote_agent_auth_user ("id") ON DELETE CASCADE,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  "scope" text,
  "password" text,
  "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS remote_agent_auth_verification (
  "id" text NOT NULL PRIMARY KEY,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Migration 026: remove the chat brief (columns added by 025).
-- DROP, not ADD, so it must run after every ADD COLUMN above and before the
-- index/comment section that names columns.
ALTER TABLE remote_agent_conversations DROP COLUMN IF EXISTS brief;
ALTER TABLE remote_agent_conversations DROP COLUMN IF EXISTS brief_updated_at;
ALTER TABLE remote_agent_conversations DROP COLUMN IF EXISTS brief_pinned;

-- ============================================================================
-- Indexes and column comments
-- ============================================================================
--
-- Every statement that names a COLUMN lives here, below every ADD COLUMN above.
-- This placement is structural, not stylistic.
--
-- `CREATE TABLE IF NOT EXISTS` is a no-op on a database that already has the
-- table, so a column declared only in a CREATE TABLE body does not exist while
-- that block runs on an upgrade — it appears later, when the additive ALTER
-- TABLE block runs. An index or COMMENT ON COLUMN written next to its
-- CREATE TABLE therefore succeeds on a fresh install and fails on an upgrade
-- with `ERROR 42703: column ... does not exist`. Because initSchema() applies
-- this file as one transaction and re-throws at fatal, that single statement
-- rolls back the entire apply and crash-loops every boot (#2508, #2443).
--
-- Keeping these statements below the additive block makes that failure
-- unrepresentable instead of something each author has to remember. Add new
-- indexes and column comments HERE, never beside the table body — and add new
-- `ALTER TABLE ... ADD COLUMN` statements ABOVE this section, not after it, so
-- this section stays last. (Both mistakes fail migration-statement-order.test.ts
-- rather than reaching a user's upgrade.)
--
-- Guarded by packages/core/src/db/migration-statement-order.test.ts and
-- exercised against real PostgreSQL upgrades by scripts/check-schema-upgrades.ts.

-- Codebase env vars
CREATE INDEX IF NOT EXISTS idx_codebase_env_vars_codebase_id
  ON remote_agent_codebase_env_vars(codebase_id);

-- User identities
CREATE INDEX IF NOT EXISTS idx_user_identities_user_id
  ON remote_agent_user_identities(user_id);

-- Better Auth core models (generated by auth@1.6.30)
CREATE INDEX IF NOT EXISTS "remote_agent_auth_session_userId_idx"
  ON remote_agent_auth_session("userId");
CREATE INDEX IF NOT EXISTS "remote_agent_auth_account_userId_idx"
  ON remote_agent_auth_account("userId");
CREATE INDEX IF NOT EXISTS "remote_agent_auth_verification_identifier_idx"
  ON remote_agent_auth_verification("identifier");

-- Codebases
COMMENT ON COLUMN remote_agent_codebases.presentation IS
  'Console presentation: {icon, color, brief:{why,doing,where,updatedAt}}. Opaque to the server.';
COMMENT ON COLUMN remote_agent_codebases.sort_order IS
  'Hand-arranged rail position. NULL means never dragged, and sorts last.';

-- Conversations
CREATE INDEX IF NOT EXISTS idx_remote_agent_conversations_codebase
  ON remote_agent_conversations(codebase_id);
CREATE INDEX IF NOT EXISTS idx_conversations_hidden
  ON remote_agent_conversations(hidden);
CREATE INDEX IF NOT EXISTS idx_conversations_codebase
  ON remote_agent_conversations(codebase_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_isolation_env_id
  ON remote_agent_conversations(isolation_env_id);
CREATE INDEX IF NOT EXISTS idx_conversations_user_id
  ON remote_agent_conversations(user_id) WHERE user_id IS NOT NULL;

COMMENT ON COLUMN remote_agent_conversations.isolation_env_id IS
  'UUID reference to isolation_environments table (the only isolation reference)';
COMMENT ON COLUMN remote_agent_conversations.sort_order IS
  'Hand-arranged rail position, ascending. NULL means never arranged; the console reads those as newest-first and shows them above every placed chat.';
COMMENT ON COLUMN remote_agent_conversations.title_pinned IS
  'A human named this chat. Automatic re-titling skips the row; an explicit request still overrides it. NULL means not pinned.';
COMMENT ON COLUMN remote_agent_conversations.completed_at IS
  'When a human marked this chat''s unit of work finished. NULL means not finished. Independent of deleted_at: done says the work landed, archived says stop showing it.';
COMMENT ON COLUMN remote_agent_conversations.last_read_at IS
  'When a human last read this chat to the end. Unread is last_activity_at > last_read_at; NULL means never read.';
COMMENT ON COLUMN remote_agent_conversations.ready_at IS
  'When the agent declared this chat''s work finished, pending a human''s judgement. Cleared when a human marks it done or sends another message. NULL means no claim. Distinct from completed_at, which is the human''s answer.';
COMMENT ON COLUMN remote_agent_conversations.pinned_provider IS
  'Provider the chat''s model/effort pin was chosen for. A turn on another provider ignores the pin. NULL means no pin.';
COMMENT ON COLUMN remote_agent_conversations.pinned_model IS
  'Model this chat runs on, overriding every default for this conversation only. NULL means the default model.';
COMMENT ON COLUMN remote_agent_conversations.pinned_effort IS
  'Reasoning effort rung this chat runs on, overriding the default. NULL means the default effort.';

-- Parked work
CREATE INDEX IF NOT EXISTS idx_parked_work_unresumed
  ON remote_agent_parked_work(conversation_id, seq) WHERE resumed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_parked_work_drain
  ON remote_agent_parked_work(drain_id);

-- Deploy events
CREATE INDEX IF NOT EXISTS idx_deploy_events_codebase
  ON remote_agent_deploy_events(codebase_id, created_at);
CREATE INDEX IF NOT EXISTS idx_deploy_runs_codebase
  ON remote_agent_deploy_runs(codebase_id, created_at);
CREATE INDEX IF NOT EXISTS idx_deploy_not_started_codebase
  ON remote_agent_deploy_not_started(codebase_id, created_at);
COMMENT ON COLUMN remote_agent_project_deploy.workflow_name IS
  'The workflow a workflow-method deploy runs, by name. NULL for archon-host, which runs none.';
CREATE INDEX IF NOT EXISTS idx_deploy_reports_codebase
  ON remote_agent_deploy_reports(codebase_id, created_at);
COMMENT ON COLUMN remote_agent_project_deploy.remote_url IS
  'Where Deploy now is sent for a remote-host deploy. NULL for every other method.';
COMMENT ON COLUMN remote_agent_project_deploy.remote_token_sha256 IS
  'SHA-256 (hex) of the credential a remote-host deploy presents. The credential is never stored.';
COMMENT ON COLUMN remote_agent_project_deploy.production_branch IS
  'The branch that holds what is live when the project deploys outside Archon. NULL: live is the newest completed Archon deploy run.';

-- Sessions
CREATE INDEX IF NOT EXISTS idx_remote_agent_sessions_conversation
  ON remote_agent_sessions(conversation_id, active);
CREATE INDEX IF NOT EXISTS idx_remote_agent_sessions_codebase
  ON remote_agent_sessions(codebase_id);
CREATE INDEX IF NOT EXISTS idx_sessions_parent
  ON remote_agent_sessions(parent_session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_conversation_started
  ON remote_agent_sessions(conversation_id, started_at DESC);

COMMENT ON COLUMN remote_agent_sessions.parent_session_id IS
  'Links to the previous session in this conversation (for audit trail)';
COMMENT ON COLUMN remote_agent_sessions.transition_reason IS
  'Why this session was created: plan-to-execute, isolation-changed, reset-requested, etc.';
COMMENT ON COLUMN remote_agent_sessions.ended_reason IS
  'Why this session was deactivated: reset-requested, cwd-changed, conversation-closed, etc.';

-- Isolation environments
-- Partial unique index: only active environments need uniqueness
CREATE UNIQUE INDEX IF NOT EXISTS unique_active_workflow
  ON remote_agent_isolation_environments (codebase_id, workflow_type, workflow_id)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_isolation_env_codebase
  ON remote_agent_isolation_environments(codebase_id);
CREATE INDEX IF NOT EXISTS idx_isolation_env_status
  ON remote_agent_isolation_environments(status);
CREATE INDEX IF NOT EXISTS idx_isolation_env_workflow
  ON remote_agent_isolation_environments(workflow_type, workflow_id);

COMMENT ON COLUMN remote_agent_isolation_environments.workflow_type IS
  'Type of work: issue, pr, review, thread, task';
COMMENT ON COLUMN remote_agent_isolation_environments.workflow_id IS
  'Identifier for the work (issue number, PR number, thread hash, etc.)';

-- Workflow runs
COMMENT ON COLUMN remote_agent_workflow_runs.conversation_id IS
  'Owning conversation. ON DELETE CASCADE erases the run rows on a hard conversation delete, silently dropping the live-run cleanup pin for its isolation environments (#2868); soft delete is the only supported path. A future hard-delete must resolve live runs first.';
CREATE INDEX IF NOT EXISTS idx_workflow_runs_conversation
  ON remote_agent_workflow_runs(conversation_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status
  ON remote_agent_workflow_runs(status);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_parent_conv
  ON remote_agent_workflow_runs(parent_conversation_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_user_id
  ON remote_agent_workflow_runs(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workflow_runs_parent_run
  ON remote_agent_workflow_runs(parent_run_id) WHERE parent_run_id IS NOT NULL;
-- Open-work inbox (#2747): adopter lookup by adopted run.
CREATE INDEX IF NOT EXISTS idx_workflow_runs_adopted_from
  ON remote_agent_workflow_runs(adopted_from_run_id) WHERE adopted_from_run_id IS NOT NULL;
-- Partial index for efficient staleness queries on running workflows
CREATE INDEX IF NOT EXISTS idx_workflow_runs_last_activity
  ON remote_agent_workflow_runs(last_activity_at)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS idx_resource_start_queue
  ON remote_agent_resource_start_requests(resource_key, status, queue_position);
CREATE INDEX IF NOT EXISTS idx_resource_start_host_queue
  ON remote_agent_resource_start_requests(host_id, status, resource_key, queue_position);
CREATE INDEX IF NOT EXISTS idx_start_binding_preparation
  ON remote_agent_start_receipt_bindings(host_id, preparation_status, created_at);

-- Workflow events
CREATE INDEX IF NOT EXISTS idx_workflow_events_run_id
  ON remote_agent_workflow_events(workflow_run_id);
CREATE INDEX IF NOT EXISTS idx_workflow_events_type
  ON remote_agent_workflow_events(event_type);
-- Global created_at index for the dashboard event poller's cross-run tail
-- (WHERE created_at >= $1 ORDER BY created_at ASC).
CREATE INDEX IF NOT EXISTS idx_workflow_events_created_at
  ON remote_agent_workflow_events(created_at);
-- Tie-breaker order within a run; NULL for rows written before event_order
-- existed, which the partial predicate keeps out of the unique constraint.
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_events_run_order
  ON remote_agent_workflow_events(workflow_run_id, event_order)
  WHERE event_order IS NOT NULL;

-- Workflow node sessions
CREATE INDEX IF NOT EXISTS idx_workflow_node_sessions_scope
  ON remote_agent_workflow_node_sessions(scope_key);
CREATE INDEX IF NOT EXISTS idx_workflow_node_sessions_workflow
  ON remote_agent_workflow_node_sessions(workflow_name);

-- Messages
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id
  ON remote_agent_messages(conversation_id, created_at ASC);

-- CI watches: one open watch per chat per commit, and the webhook's lookup by commit.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ci_watches_open_unique
  ON remote_agent_ci_watches(conversation_id, repo, head_sha) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_ci_watches_head
  ON remote_agent_ci_watches(repo, head_sha) WHERE status = 'open';
