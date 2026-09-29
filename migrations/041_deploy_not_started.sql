-- A merge that should have started a project's deploy and did not (#236).
--
-- Its own table rather than a new kind in remote_agent_deploy_events: that
-- table's kind column is a shipped CHECK list, and widening it is a constraint
-- rebuild older binaries never expect. `reason` is the sentence the person
-- would have been shown; the cause itself stays in the server log.
CREATE TABLE IF NOT EXISTS remote_agent_deploy_not_started (
  id UUID PRIMARY KEY,
  codebase_id UUID NOT NULL REFERENCES remote_agent_codebases(id) ON DELETE CASCADE,
  sha VARCHAR(64) NOT NULL,
  trigger_ref TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deploy_not_started_codebase
  ON remote_agent_deploy_not_started(codebase_id, created_at);

COMMENT ON TABLE remote_agent_deploy_not_started IS
  'Merges that should have started a project''s deploy and did not, with the reason. Read into the project''s deploy log.';
