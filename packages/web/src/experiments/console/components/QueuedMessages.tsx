import type { ReactElement } from 'react';
import type { QueuedMessage } from '../skills/conversations';

interface QueuedMessagesProps {
  messages: readonly QueuedMessage[];
  /** Pull the message back into the composer (withdraw, then restore its text). */
  onEdit: (message: QueuedMessage) => void;
  /** Withdraw the message and discard it. */
  onRemove: (message: QueuedMessage) => void;
  /** Ids with a withdraw in flight — their buttons wait for the server's answer. */
  busyIds: ReadonlySet<string>;
}

/**
 * Messages sent while the agent was working, waiting their turn.
 *
 * Drawn as your own bubble, dashed and dimmed: it is yours and it is not yet
 * part of the conversation. The list is the server's, not this tab's — the
 * same list a reload or a second tab reads — so a bubble disappears when the
 * server delivers or withdraws it, never on a guess here.
 */
export function QueuedMessages({
  messages,
  onEdit,
  onRemove,
  busyIds,
}: QueuedMessagesProps): ReactElement | null {
  if (messages.length === 0) return null;
  return (
    <ol
      aria-label="Queued messages"
      className="mt-[var(--msg-gap)] flex flex-col items-end gap-[var(--msg-gap)]"
    >
      {messages.map(message => {
        const busy = busyIds.has(message.id);
        return (
          <li key={message.id} className="flex w-full flex-col items-end gap-[0.25rem]">
            <div
              className="max-w-[64ch] rounded-[var(--radius-panel)_var(--radius-panel)_var(--radius-control)_var(--radius-panel)] px-[var(--bubble-x)] py-[var(--bubble-y)] text-[length:var(--text-medium)] leading-[1.55] break-words whitespace-pre-wrap text-text-secondary"
              style={{
                border: '1px dashed color-mix(in oklch, var(--accent), transparent 45%)',
                background: 'color-mix(in oklch, var(--accent), transparent 95%)',
              }}
            >
              {message.text.trim()}
            </div>
            <div className="flex items-center gap-[0.5rem] font-mono text-[length:var(--text-micro)] text-text-tertiary">
              <span className="uppercase tracking-[0.11em]">
                Queued
                {message.files.length > 0
                  ? ` · ${String(message.files.length)} file${message.files.length === 1 ? '' : 's'}`
                  : ''}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  onEdit(message);
                }}
                className="rounded-[var(--radius-control)] border border-border-bright px-[0.45rem] py-[0.1rem] text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50"
              >
                Edit
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  onRemove(message);
                }}
                className="rounded-[var(--radius-control)] border border-border-bright px-[0.45rem] py-[0.1rem] text-text-secondary transition-colors hover:text-error disabled:opacity-50"
              >
                Remove
              </button>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
