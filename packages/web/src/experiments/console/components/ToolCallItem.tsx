import { memo, useState, type ReactElement } from 'react';
import { formatRelativeToBaseline } from '../lib/format';
import { useClock } from '../lib/clock';
import { useStreamContext } from '../lib/stream-context';
import type { InlineToolCall } from '../primitives/message';

interface ToolCallItemProps {
  call: InlineToolCall;
  /** Carried from the parent message since metadata tool calls don't track their own timestamp. */
  timestamp: string;
}

function argsSummary(input: Record<string, unknown>): string {
  const keys = Object.keys(input);
  if (keys.length === 0) return '';
  const parts: string[] = [];
  for (const k of keys.slice(0, 2)) {
    const v = input[k];
    const rendered =
      typeof v === 'string' ? `"${v.length > 48 ? `${v.slice(0, 48)}…` : v}"` : JSON.stringify(v);
    parts.push(`${k}=${rendered}`);
  }
  if (keys.length > 2) parts.push(`+${(keys.length - 2).toString()}`);
  return parts.join(' ');
}

/**
 * Tool-call row, design v3 (.log-row.tool): offset gutter · purple TOOL tag ·
 * name + args preview · duration · chevron. Clicking toggles the expanded
 * args/result detail below the row.
 */
function ToolCallItemImpl({ call, timestamp }: ToolCallItemProps): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const { runStartedAt } = useStreamContext();
  const displayed = formatRelativeToBaseline(timestamp, runStartedAt);
  const wallClock = useClock()(timestamp);
  const summary = argsSummary(call.input);
  const hasDetails =
    Object.keys(call.input).length > 0 || (call.output !== undefined && call.output.length > 0);

  return (
    <div
      onClick={
        hasDetails
          ? (): void => {
              setExpanded(v => !v);
            }
          : undefined
      }
      className={`flex flex-col border-b border-border/60 py-[7px] ${
        hasDetails ? 'cursor-pointer transition-colors hover:bg-surface-hover/50' : ''
      }`}
    >
      <div className="flex items-center gap-3">
        <time
          dateTime={timestamp}
          title={wallClock}
          className="w-14 shrink-0 text-small tabular-nums text-text-tertiary"
        >
          {displayed}
        </time>
        <span
          className="shrink-0 rounded-[5px] border px-[7px] py-[2px] text-mini font-medium"
          // Inline because the console scope's wildcard border-color rule
          // repaints Tailwind border utilities (see theme.css).
          style={{
            color: 'var(--accent)',
            background: 'color-mix(in oklch, var(--accent), transparent 86%)',
            borderColor: 'color-mix(in oklch, var(--accent), transparent 70%)',
          }}
        >
          Tool
        </span>
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="shrink-0 text-body font-medium text-text-primary">{call.name}</span>
          {summary.length > 0 ? (
            <span className="min-w-0 truncate font-mono text-body text-text-tertiary">
              {summary}
            </span>
          ) : null}
        </span>
        {call.durationMs !== undefined ? (
          <span className="shrink-0 text-small tabular-nums text-text-tertiary">
            {call.durationMs.toString()}ms
          </span>
        ) : null}
        {hasDetails ? (
          <span
            aria-hidden
            className="shrink-0 text-small text-text-tertiary transition-transform"
            style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
          >
            ▸
          </span>
        ) : null}
      </div>
      {expanded && hasDetails ? (
        <div className="ml-[72px] mt-2 space-y-1.5">
          {Object.keys(call.input).length > 0 ? (
            <pre className="max-h-[320px] overflow-auto rounded border border-border bg-surface-inset p-2 text-small leading-relaxed text-text-secondary">
              {JSON.stringify(call.input, null, 2)}
            </pre>
          ) : null}
          {call.output !== undefined && call.output.length > 0 ? (
            <div>
              <div className="mb-0.5 text-mini font-medium text-text-tertiary">Result</div>
              <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded border border-border bg-surface-inset p-2 text-small leading-relaxed text-text-secondary">
                {call.output.length > 2000
                  ? `${call.output.slice(0, 2000)}\n\n… (${(call.output.length - 2000).toString()} more chars)`
                  : call.output}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Memoized for the same reason as MessageItem — see the note there. */
/* eslint-disable-next-line @typescript-eslint/naming-convention --
   A memoized component is a const, and a component must be PascalCase for JSX
   to treat it as one. The rule cannot express "const holding a component". */
export const ToolCallItem = memo(
  ToolCallItemImpl,
  (a, b) =>
    a.call.name === b.call.name &&
    a.call.output === b.call.output &&
    a.call.durationMs === b.call.durationMs &&
    a.timestamp === b.timestamp
);
