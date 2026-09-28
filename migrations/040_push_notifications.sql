-- Web Push for the phone (mobile shell, phase 4).
--
-- A subscription is one browser's push endpoint and the keys its payloads are
-- encrypted to. The push service is the authority on whether it still works:
-- a 404 or 410 from it deletes the row, and nothing else expires one.
-- One install serves one operator, so subscriptions belong to the install.
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

-- What to be told about. `scope_id` is '' for the one global row, the codebase
-- id for a project, and the platform conversation id for a chat — the id every
-- client already uses for it. No foreign keys: chats are soft-deleted, and a
-- leftover preference for a gone chat or project is never read.
--
-- `mode` resolves chat → project → global: a chat's own mode wins unless it is
-- `default`; a muted project silences its chats' defaults. The three notify_*
-- columns are the global triggers and are read only on the global row; NULL
-- means on, which is also what an install with no row gets.
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
