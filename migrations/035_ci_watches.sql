-- A chat's standing request to hear when CI finishes on one commit.
--
-- A chat that says "I'll tell you when CI is done" used to mean it with a timer
-- inside its own turn — a monitor, a background shell, a scheduled wake-up.
-- Every one of those dies when the turn ends or the container is replaced, so
-- the promise was never kept and the rail read Idle while CI ran. The request
-- has to outlive the turn that made it, so it is a row.
--
-- Keyed by the HEAD COMMIT, not by pull request: one `check_run` event arrives
-- per job, and whether CI is finished is a question about every check on that
-- commit. The webhook is the signal to ask; GitHub's check state for the SHA is
-- the answer.
--
-- `status` moves open -> fired or open -> cancelled, never back except when a
-- delivery is refused mid-drain (see `releaseCiWatch`). The open -> fired
-- transition is a compare-and-set, which is what makes a watch fire at most
-- once when a webhook and the reconcile sweep race for it.
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

-- One open watch per chat per commit: asking twice is the same request.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ci_watches_open_unique
  ON remote_agent_ci_watches(conversation_id, repo, head_sha) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_ci_watches_head
  ON remote_agent_ci_watches(repo, head_sha) WHERE status = 'open';
