-- The model and reasoning effort one chat runs on, chosen inside that chat.
--
-- Until now the only way to change the model was the global default, so a
-- quick question and a hard problem ran on the same model and cost the same.
-- This is the per-chat answer to that: a pin that outranks every default for
-- this conversation only, and touches no other chat and no default.
--
-- THREE COLUMNS, AND THE PROVIDER IS ONE OF THEM. A model name only means
-- something on the provider it was chosen for, so the pin records which one.
-- A turn that resolves to a different provider (the default assistant changed
-- after the pin was set) ignores the pin rather than handing an Anthropic model
-- id to Codex — the same rule the per-user default model already follows.
-- `pinned_model` and `pinned_effort` are independently nullable: effort can be
-- raised without choosing a model, and the other way round.
--
-- No backfill: NULL is "no pin" and is the truthful answer for every row that
-- predates the columns. An older binary never reads them, so a pinned chat
-- simply runs on its defaults there — the failure is the old behaviour, not a
-- wrong model.
ALTER TABLE remote_agent_conversations
  ADD COLUMN IF NOT EXISTS pinned_provider VARCHAR(64);
ALTER TABLE remote_agent_conversations
  ADD COLUMN IF NOT EXISTS pinned_model VARCHAR(255);
ALTER TABLE remote_agent_conversations
  ADD COLUMN IF NOT EXISTS pinned_effort VARCHAR(16);

COMMENT ON COLUMN remote_agent_conversations.pinned_provider IS
  'Provider the chat''s model/effort pin was chosen for. A turn on another provider ignores the pin. NULL means no pin.';
COMMENT ON COLUMN remote_agent_conversations.pinned_model IS
  'Model this chat runs on, overriding every default for this conversation only. NULL means the default model.';
COMMENT ON COLUMN remote_agent_conversations.pinned_effort IS
  'Reasoning effort rung this chat runs on, overriding the default. NULL means the default effort.';
