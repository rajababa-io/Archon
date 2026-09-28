-- A project deploys by running an Archon workflow in its own repository (#226).
--
-- `workflow_name` names that workflow for a `workflow`-method row. It is NULL for
-- `archon-host`, which deploys this install through the host's request file and
-- runs no workflow. Nullable so a row an older binary wrote stays valid, and so
-- an older binary, which never names the column, can still insert one.
ALTER TABLE remote_agent_project_deploy
  ADD COLUMN IF NOT EXISTS workflow_name VARCHAR(255);

COMMENT ON COLUMN remote_agent_project_deploy.workflow_name IS
  'The workflow a workflow-method deploy runs, by name. NULL for archon-host, which runs none.';

-- Which workflow run was a deploy, and which commit it was asked to ship. The
-- run's own status is the deploy's verdict; nothing here copies it. What is live
-- is the commit of the newest row whose run completed.
CREATE TABLE IF NOT EXISTS remote_agent_deploy_runs (
  run_id UUID PRIMARY KEY REFERENCES remote_agent_workflow_runs(id) ON DELETE CASCADE,
  codebase_id UUID NOT NULL REFERENCES remote_agent_codebases(id) ON DELETE CASCADE,
  sha VARCHAR(64) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deploy_runs_codebase
  ON remote_agent_deploy_runs(codebase_id, created_at);

COMMENT ON TABLE remote_agent_deploy_runs IS
  'Workflow runs that were a project''s deploy, with the commit each was asked to ship. Live is the newest one whose run completed.';
