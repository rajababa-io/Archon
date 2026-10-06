import { memo, type ReactElement } from 'react';
import { AskCard } from './AskCard';
import { Markdown } from './Markdown';
import { useClock } from '../lib/clock';
import { cardsLast, splitReply } from '@archon/awaiting';
import { AskErrorCard } from './AskErrorCard';
import type { Message } from '../primitives/message';

interface MessageItemProps {
  message: Message;
}

const ERROR_BLOCK = (msg: string): ReactElement => (
  <div className="mt-2 rounded border border-error/40 bg-error/10 px-2 py-1.5 text-body text-error">
    {msg}
  </div>
);

/**
 * A message inside a RUN LOG: violet left accent, mono body, no avatar.
 *
 * This used to serve the chat as well, behind a `variant` prop. It no longer
 * does — the chat groups consecutive messages under one header and renders
 * them flat, which is a different enough shape that sharing one component
 * meant two layouts interleaved through every branch. See `ChatGroup`.
 *
 * A run log is a record, so nothing here is interactive: an ask block renders
 * as what was asked, not as something to answer.
 */
function MessageItemImpl({ message }: MessageItemProps): ReactElement {
  const content = message.content.trim();
  const clock = useClock()(message.timestamp);
  const label = message.role === 'system' ? 'System' : message.role === 'user' ? 'You' : 'Agent';

  return (
    <div className="group relative flex flex-col">
      <header className="mb-2 flex items-center gap-[9px]">
        <span
          className="rounded px-[7px] py-[2px] text-mini font-medium"
          style={{
            color: 'var(--accent-bright)',
            background: 'color-mix(in oklch, var(--accent), transparent 88%)',
          }}
        >
          {label}
        </span>
        <time dateTime={message.timestamp} title={clock} className="text-small text-text-tertiary">
          {clock}
        </time>
      </header>
      <div
        className="rounded-lg border bg-[color:var(--surface-elevated)] px-3 py-[8.5px]"
        style={{ borderColor: 'var(--border)', borderLeft: '3px solid var(--accent)' }}
      >
        {content.length > 0 ? (
          <div className="max-w-none text-body leading-[1.7] text-text-secondary">
            {cardsLast(splitReply(content)).map((part, i) => {
              if (part.kind === 'ask') return <AskCard key={`ask-${String(i)}`} spec={part.spec} />;
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
        {message.error !== null ? ERROR_BLOCK(message.error.message) : null}
      </div>
    </div>
  );
}

/**
 * A rendered message is expensive — markdown parsing, code highlighting, ask
 * cards — and a run's transcript refetches wholesale every few seconds while
 * the run works. Without this, hundreds of unchanged messages re-render on
 * every poll.
 *
 * Compared by value, not by reference: each refetch builds new objects, so
 * reference equality would never hit. A persisted message never changes, and
 * the one case that does — the last message growing as a reply streams — is
 * caught by comparing `content`.
 */
/* eslint-disable-next-line @typescript-eslint/naming-convention --
   A memoized component is a const, and a component must be PascalCase for JSX
   to treat it as one. The rule cannot express "const holding a component". */
export const MessageItem = memo(MessageItemImpl, (a, b) => {
  return (
    a.message.id === b.message.id &&
    a.message.content === b.message.content &&
    a.message.category === b.message.category &&
    a.message.toolCalls.length === b.message.toolCalls.length &&
    a.message.error === b.message.error
  );
});
