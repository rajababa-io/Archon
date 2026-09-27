import { Paperclip } from 'lucide-react';
import { memo, useState, type ReactElement } from 'react';
import { AskCard } from './AskCard';
import { Markdown } from './Markdown';
import { copyLabel, useCopy } from '../lib/clipboard';
import { useClock } from '../lib/clock';
import { splitReply } from '../primitives/ask';
import { AskErrorCard } from './AskErrorCard';
import { formatBytes } from '../primitives/file';
import { progressNoteIds, type MessageGroup } from '../primitives/message-groups';
import type { Message } from '../primitives/message';

interface ChatGroupProps {
  group: MessageGroup;
  /**
   * Send an answer to an ask block in this group. Absent in read-only
   * surfaces, where the card renders as a record of what was asked rather than
   * something to fill in.
   */
  onAnswer?: (text: string, files?: File[]) => void;
}

/**
 * Attachments sent with a message. Rendered only on the user bubble: the server
 * records file metadata on the user's message, so no other role carries any.
 *
 * The chip is deliberately not a link. The upload is ephemeral — the server
 * deletes it once the agent has read it and omits the path from the stored
 * metadata — so there is nothing left to open. The tooltip says so, because a
 * chip that looks like a file and does nothing reads as a broken link.
 */
function FileChips({ files }: { files: Message['files'] }): ReactElement {
  return (
    <div className="flex flex-wrap justify-end gap-[0.375rem]">
      {files.map((f, i) => (
        <span
          key={`${f.name}-${String(i)}`}
          title={`${f.name} · ${formatBytes(f.size)}\nSent to the agent. The file was deleted from the server once it was read — this is a record of the upload, not a copy of it.`}
          className="flex items-center gap-[0.375rem] rounded-[var(--radius-card)] border border-border-bright bg-[color:var(--surface-elevated)] px-[0.5rem] py-[0.2rem] text-[length:var(--text-micro)]"
        >
          <Paperclip aria-hidden className="h-[0.75rem] w-[0.75rem] text-text-tertiary" />
          <span className="max-w-[180px] truncate text-text-secondary">{f.name}</span>
          <span className="font-mono text-text-tertiary">{formatBytes(f.size)}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * A line the agent wrote on its way to the answer, shown as one muted line.
 *
 * Folded rather than dropped: it is still what the agent said, so a click
 * opens it in full. Only the first line shows while folded, because that is
 * where the agent puts its headline, and the headline is exactly what made a
 * note read as a second reply (#125).
 */
function ProgressNote({ content }: { content: string }): ReactElement {
  const [open, setOpen] = useState(false);
  const firstLine = content.split('\n', 1)[0] ?? '';
  return (
    <div className="max-w-[74ch] min-w-0 text-[length:var(--text-small)] text-text-tertiary">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen(v => !v);
        }}
        className="flex w-full min-w-0 items-baseline gap-[0.4rem] text-left hover:text-text-secondary"
      >
        <span aria-hidden className="shrink-0 font-mono">
          {open ? '▾' : '▸'}
        </span>
        {open ? (
          <span className="sr-only">Hide progress note</span>
        ) : (
          <span className="truncate">{firstLine}</span>
        )}
      </button>
      {open ? (
        <div className="mt-[0.25rem] border-l border-border pl-[0.75rem] text-text-secondary">
          <Markdown>{content}</Markdown>
        </div>
      ) : null}
    </div>
  );
}

/**
 * What the agent thought before this message, folded to one line by default.
 *
 * Folded because it is the working-out, not the answer: open, a long thought
 * would push the reply it led to off the screen. It is still worth a click,
 * because a wrong turn shows up in the thinking before it shows up in the
 * work — which is when stopping it is cheapest.
 */
function ThinkingBlock({ text }: { text: string }): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div className="max-w-[74ch] min-w-0 text-[length:var(--text-small)] text-text-tertiary">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen(v => !v);
        }}
        className="flex items-baseline gap-[0.4rem] text-left hover:text-text-secondary"
      >
        <span aria-hidden className="shrink-0 font-mono">
          {open ? '▾' : '▸'}
        </span>
        <span className="italic">{open ? 'Hide thinking' : 'Thinking'}</span>
      </button>
      {open ? (
        <div className="mt-[0.25rem] border-l border-border pl-[0.75rem] whitespace-pre-wrap text-text-secondary">
          {text.trim()}
        </div>
      ) : null}
    </div>
  );
}

function ErrorBlock({ message }: { message: string }): ReactElement {
  return (
    <div className="rounded-[var(--radius-card)] border border-error/40 bg-error/10 px-[0.6rem] py-[0.4rem] font-mono text-[length:var(--text-small)] text-error">
      {message}
    </div>
  );
}

/**
 * One sender's run of messages, under a single label and timestamp.
 *
 * WHAT CHANGED, AND WHY: every message used to carry its own label, its own
 * timestamp, a 30px avatar and a bordered card — roughly 100px of frame around
 * a one-sentence narration, repeated for every line of a turn. The frame told
 * you nothing the position and the colour did not. So:
 *
 *  - Agent and system prose sit DIRECTLY on the background. Code blocks and ask
 *    cards keep their own containers, because those are structure rather than
 *    decoration.
 *  - You keep the bubble and the right edge. Both say "you" unambiguously, so
 *    the word was the one piece of pure redundancy and it is gone.
 *  - Agent takes the accent; system is muted, because it is an aside about the
 *    conversation rather than a participant in it.
 *
 * Every size and gap here is a token, so the text-size and density controls
 * reach the transcript. They did not before: the whole component was pixel
 * literals, which ignore a root font-size by construction.
 */
function ChatGroupImpl({ group, onAnswer }: ChatGroupProps): ReactElement {
  const clock = useClock()(group.timestamp);
  const { state: copyState, copy } = useCopy();
  const isUser = group.role === 'user';
  const isSystem = group.role === 'system';
  const notes = progressNoteIds(group);

  const meta = (
    <time
      dateTime={group.timestamp}
      title={clock}
      className="font-mono text-[length:var(--text-micro)] text-text-tertiary tabular-nums"
    >
      {clock}
    </time>
  );

  if (isUser) {
    return (
      <div className="flex flex-col items-end gap-[var(--msg-gap)]">
        <header className="flex items-baseline justify-end">{meta}</header>
        {group.messages.map(message => (
          <div key={message.id} className="flex w-full flex-col items-end gap-[var(--msg-gap)]">
            <div
              // `whitespace-pre-wrap`: the bubble renders raw text, so without
              // it every newline, blank line and indent in a pasted block
              // collapses into one run-on line. Deliberately not markdown —
              // people paste terminal output, paths and code into chat, and
              // markdown would eat the underscores and asterisks in them.
              className="max-w-[64ch] rounded-[var(--radius-panel)_var(--radius-panel)_var(--radius-control)_var(--radius-panel)] px-[var(--bubble-x)] py-[var(--bubble-y)] text-[length:var(--text-medium)] leading-[1.55] break-words whitespace-pre-wrap"
              style={{
                background: 'color-mix(in oklch, var(--accent), transparent 88%)',
                border: '1px solid color-mix(in oklch, var(--accent), transparent 58%)',
                // NOT `white`. The background is only a 12% accent tint, so in
                // light mode that was near-white text on a near-white bubble —
                // measured at 1.09:1, your own messages effectively invisible.
                // --text-primary inverts with the mode, so the tint survives
                // and the contrast follows the theme.
                color: 'color-mix(in oklch, var(--text-primary), var(--accent) 8%)',
              }}
            >
              {message.content.trim()}
            </div>
            {message.files.length > 0 ? <FileChips files={message.files} /> : null}
            {message.error !== null ? <ErrorBlock message={message.error.message} /> : null}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="group relative flex flex-col gap-[var(--msg-gap)]">
      <header className="flex items-baseline gap-[0.5rem]">
        <span
          className="font-mono text-[length:var(--text-micro)] font-semibold uppercase tracking-[0.11em]"
          // System is deliberately quieter than the agent: it narrates the
          // conversation rather than taking part in it, and painting it as
          // loudly would invert the hierarchy.
          style={{ color: isSystem ? 'var(--text-tertiary)' : 'var(--accent-bright)' }}
        >
          {isSystem ? 'System' : 'Agent'}
        </span>
        {meta}
        <button
          type="button"
          onClick={() => {
            // The markdown source of the WHOLE group, not the rendered text —
            // so fences survive and a multi-part reply pastes as one piece.
            copy(group.messages.map(m => m.content).join('\n\n'));
          }}
          aria-label="Copy message as markdown"
          className={`ml-auto flex items-center gap-1.5 rounded-[var(--radius-control)] border border-border-bright px-[0.45rem] py-[0.1rem] text-[length:var(--text-micro)] transition-opacity focus:opacity-100 group-hover:opacity-100 ${
            copyState === 'idle' ? 'opacity-0' : 'opacity-100'
          } ${copyState === 'copied' ? 'text-success' : 'text-text-secondary hover:text-text-primary'}`}
        >
          <span aria-hidden>{copyState === 'copied' ? '✓' : '⧉'}</span>
          {copyLabel(copyState, 'Copy message', 'Message copied')}
        </button>
      </header>
      {/* Announced as well as shown: a visual-only confirmation leaves a
          screen-reader user with no idea whether it worked. */}
      <span aria-live="polite" className="sr-only">
        {copyState === 'copied' ? 'Message copied to clipboard' : ''}
      </span>
      {group.messages.map(message => {
        const content = message.content.trim();
        return (
          <div key={message.id} className="flex flex-col gap-[var(--msg-gap)]">
            {message.thinking !== null ? <ThinkingBlock text={message.thinking} /> : null}
            {notes.has(message.id) ? (
              <ProgressNote content={content} />
            ) : content.length > 0 ? (
              <div
                className={`max-w-[74ch] min-w-0 text-[length:var(--text-medium)] leading-[1.62] ${
                  isSystem ? 'text-text-secondary' : 'text-text-primary'
                }`}
              >
                {splitReply(content).map((part, i) => {
                  if (part.kind === 'ask')
                    return (
                      <AskCard key={`ask-${String(i)}`} spec={part.spec} onAnswer={onAnswer} />
                    );
                  if (part.kind === 'ask-error')
                    return (
                      <AskErrorCard
                        key={`ask-err-${String(i)}`}
                        reason={part.reason}
                        text={part.text}
                      />
                    );
                  return <Markdown key={`md-${String(i)}`}>{part.text}</Markdown>;
                })}
              </div>
            ) : null}
            {message.error !== null ? <ErrorBlock message={message.error.message} /> : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * A rendered group is expensive — markdown parsing, code highlighting, ask
 * cards — and the transcript refetches wholesale every few seconds while the
 * agent works. Without this, 700 unchanged messages re-render on every poll
 * and block the main thread for half a second, which is precisely when you are
 * typing your next one.
 *
 * Compared by value, not by reference: each refetch builds new objects, so
 * reference equality would never hit. A persisted message never changes; the
 * two cases that do — the last message growing as a reply streams, and a new
 * message joining the group — are caught by the length and content checks.
 */
/* eslint-disable-next-line @typescript-eslint/naming-convention --
   A memoized component is a const, and a component must be PascalCase for JSX
   to treat it as one. The rule cannot express "const holding a component". */
export const ChatGroup = memo(ChatGroupImpl, (a, b) => {
  if (a.onAnswer !== b.onAnswer) return false;
  if (a.group.key !== b.group.key) return false;
  if (a.group.messages.length !== b.group.messages.length) return false;
  return a.group.messages.every((m, i) => {
    const other = b.group.messages[i];
    return (
      other?.id === m.id &&
      other.content === m.content &&
      other.thinking === m.thinking &&
      other.error === m.error
    );
  });
});
