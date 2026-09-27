-- Work a deploy parked so it could replace the container (#144).
--
-- A deploy drains the server before swapping it: new work is refused and old
-- work is waited for. On a busy box the wait never ended — agent turns run for
-- tens of minutes, several at once — so after a grace window the deploy now
-- PARKS what is still running: it interrupts chat turns, takes the messages
-- queued behind them, and pauses the workflow runs this server executes. The
-- replacement server resumes exactly that work.
--
-- WHY A TABLE OF ITS OWN. Queued messages are not transcript rows (a user
-- message is written to remote_agent_messages when its turn STARTS, not when it
-- is sent), and replaying one needs its staged file paths and sender, which do
-- not belong in the transcript. Runs share the table so one drain has one
-- report of what it parked and what came back.
--
-- PROVENANCE. Only the park step writes rows here. A resuming server replays
-- these rows and nothing else, which is what keeps it from guessing about a
-- `running` row whose owner it cannot see. `resumed_at` is set by a
-- compare-and-swap before the work is dispatched, so a crash during replay can
-- lose at most the one row being claimed and can never run a row twice.
--
-- Older binaries never read the table: parked work then waits for a current
-- binary to boot. Delayed, never corrupted.
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

CREATE INDEX IF NOT EXISTS idx_parked_work_unresumed
  ON remote_agent_parked_work(conversation_id, seq) WHERE resumed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_parked_work_drain
  ON remote_agent_parked_work(drain_id);

COMMENT ON TABLE remote_agent_parked_work IS
  'Chat turns, queued messages and workflow runs a deploy stopped before replacing the container. resumed_at is set exactly once, by whichever process claims the row to resume it.';
