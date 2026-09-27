-- Per-project deploy settings and the deploy log a person reads (#211).
--
-- WHY. On 2026-09-27 three chat-requested deploys started within an hour while
-- about ten chats were working; each one blocked new messages during its drain
-- and was stopped by hand from a terminal. Whether a merge ships on its own is
-- now a per-project setting a person flips in the console, and every flip and
-- every deploy decision is written down where that person can read it.
--
-- WHY A TABLE OF ITS OWN, not columns on remote_agent_codebases. Most projects
-- have no deploy at all, and "no row" is the truthful answer for them — the
-- console draws no deploy row for such a project. A column pair would have to
-- invent a meaning for `deploy_on_merge` on a project that cannot deploy.
--
-- `method` names HOW the project deploys. It is a closed set the server knows
-- how to drive; a project whose method the running binary does not know is
-- treated as having no deploy, never guessed at.
--
-- Older binaries never read either table: the host then finds no policy
-- endpoint and holds every merge-sourced request, which is the safe direction.
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

-- One row per thing a person did, or asked for, from the console. The deploy's
-- own verdicts (held, OK, failed, killed) are NOT copied here: the host writes
-- them to deploy-history, and a second copy would be a pair kept in agreement
-- by hand. The Overview log merges the two at read time.
CREATE TABLE IF NOT EXISTS remote_agent_deploy_events (
  id UUID PRIMARY KEY,
  codebase_id UUID NOT NULL REFERENCES remote_agent_codebases(id) ON DELETE CASCADE,
  kind VARCHAR(32) NOT NULL CHECK (kind IN ('toggle_on', 'toggle_off', 'deploy_requested', 'deploy_cancelled')),
  actor TEXT,
  sha VARCHAR(64),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deploy_events_codebase
  ON remote_agent_deploy_events(codebase_id, created_at);

COMMENT ON TABLE remote_agent_deploy_events IS
  'Deploy actions a person took in the console: toggle flips, Deploy now, Cancel deploy. A deploy_requested id is the token the host checks before honouring a manual request.';
