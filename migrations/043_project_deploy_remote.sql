-- A project that deploys itself on another host, which asks Archon first (#220).
--
-- The `remote-host` method: the host pulls the branch on its own (a push
-- webhook, say), but before it deploys it asks Archon whether Deploy on Merge
-- lets it, and afterwards it reports what it did. Archon never reaches in to
-- run the deploy; Deploy now asks the host to ask again with a token only a
-- person's press can issue.
--
-- `remote_url` is where Deploy now is sent. `remote_token_sha256` is the SHA-256
-- of the credential that host presents; the credential itself is never stored,
-- and it identifies the project, so the host names nothing else. Both are NULL
-- for every other method, and nullable so an older binary can still insert.
ALTER TABLE remote_agent_project_deploy
  ADD COLUMN IF NOT EXISTS remote_url TEXT;
ALTER TABLE remote_agent_project_deploy
  ADD COLUMN IF NOT EXISTS remote_token_sha256 VARCHAR(64);

COMMENT ON COLUMN remote_agent_project_deploy.remote_url IS
  'Where Deploy now is sent for a remote-host deploy. NULL for every other method.';
COMMENT ON COLUMN remote_agent_project_deploy.remote_token_sha256 IS
  'SHA-256 (hex) of the credential a remote-host deploy presents. The credential is never stored.';

-- What a remote host did with a deploy: held, deployed, or failed. The host is
-- the only witness, so its report is the record. `live_sha` is what the host
-- was running once it had acted, which is how Archon knows what is live there.
-- `verdict` is checked in code, not by a CHECK list, so a later verdict is an
-- additive change rather than a constraint rebuild.
CREATE TABLE IF NOT EXISTS remote_agent_deploy_reports (
  id UUID PRIMARY KEY,
  codebase_id UUID NOT NULL REFERENCES remote_agent_codebases(id) ON DELETE CASCADE,
  verdict VARCHAR(16) NOT NULL,
  sha VARCHAR(64) NOT NULL,
  live_sha VARCHAR(64) NOT NULL,
  reason TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deploy_reports_codebase
  ON remote_agent_deploy_reports(codebase_id, created_at);

COMMENT ON TABLE remote_agent_deploy_reports IS
  'What a remote-host deploy reported doing: held, ok or failed, with the commit it was running afterwards.';
