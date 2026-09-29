-- The console tab each signed-in person last picked (#251).
--
-- `person` is the email on a verified Cloudflare Access pass — the only
-- identity this install can prove for a browser without Better Auth or a
-- trusted proxy header. `scope_id` is '' for All projects and the codebase id
-- for a project. No foreign key: a leftover choice for a deleted project is
-- never read, and costs one row.
CREATE TABLE IF NOT EXISTS remote_agent_console_view_prefs (
  person TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  view VARCHAR(16) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  PRIMARY KEY (person, scope_id)
);

COMMENT ON TABLE remote_agent_console_view_prefs IS
  'Last console tab per signed-in person: All projects (scope_id empty) and each project.';
