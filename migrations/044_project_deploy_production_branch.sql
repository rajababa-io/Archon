-- The branch a project's production runs from (#265, #266).
--
-- `branch` is where merges land; `production_branch` is the branch that holds
-- what is live, for a project whose deploy happens outside Archon (a merge of
-- `main` into `production` that the repository's own CI deploys). When it is
-- set, a workflow deploy's live commit is that branch's tip and "waiting" is
-- what `branch` has that it does not; when it is NULL, the live commit is the
-- newest deploy run Archon itself completed, as before. Nullable, so an older
-- binary can still insert.
ALTER TABLE remote_agent_project_deploy
  ADD COLUMN IF NOT EXISTS production_branch VARCHAR(255);

COMMENT ON COLUMN remote_agent_project_deploy.production_branch IS
  'The branch that holds what is live when the project deploys outside Archon. NULL: live is the newest completed Archon deploy run.';
