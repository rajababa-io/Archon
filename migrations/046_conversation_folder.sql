-- A folder a chat is filed under in the console's chat list (#396).
--
-- A folder is only its name: it exists while at least one chat carries it, so
-- there is no folder table to keep in step with the chats. Filing a chat changes
-- nothing about its state — an open chat in a folder is still open. NULL means
-- not in a folder, which is true of every row that predates the column, so
-- there is nothing to backfill. Older binaries never write it.
ALTER TABLE remote_agent_conversations
  ADD COLUMN IF NOT EXISTS folder VARCHAR(100);

COMMENT ON COLUMN remote_agent_conversations.folder IS
  'Name of the console folder this chat is filed under. NULL means not in a folder. Presentation only; independent of completed_at and deleted_at.';
