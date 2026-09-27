import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { describeActivity, formatElapsed, traceLine } from '../primitives/activity';
import { STATUS_COLOR, STATUS_LABEL, type ChatStatus } from '../primitives/chat-status';
import type { InlineToolCall } from '../primitives/message';

/** How many trace rows to render before collapsing the rest into a count. */
const TRACE_LIMIT = 12;

interface ChatStatusStripProps {
  /** Where the chat is, in the same words the rail's dot stands for. */
  status: ChatStatus;
  /** When the current turn started, as epoch ms. Only read while working. */
  since?: number | null;
  /** When the chat last said anything. Only read while idle. */
  lastActivityAt?: string | null;
  /** Every tool the current (or, when idle, the most recent) turn invoked. */
  trace: readonly InlineToolCall[];
  /**
   * What the server says this chat is running RIGHT NOW, when it says anything.
   *
   * The trace cannot answer this, and not by a small margin: tool calls are
   * buffered in the adapter and written to the database when the turn ENDS, so
   * for the whole length of a turn the trace holds nothing from it and the line
   * below read "Thinking" no matter what the agent was doing. This comes off
   * the conversation lock's own map, pushed on the dashboard stream, so it is
   * current within a tool call rather than within a turn.
   *
   * Names the label only. The trace beneath the pill stays the persisted
   * record — it carries durations and it is a history, and injecting a live
   * entry into it would either duplicate the row when it lands or show one
   * that never finishes.
   */
  live?: { name: string; input: Record<string, string> } | null;
  /** Whether the trace below the strip is revealed. */
  expanded: boolean;
  onToggle: () => void;
  /**
   * Rendered on the strip's own line, to the right of the pill.
   *
   * A slot rather than a sibling because this component is a COLUMN — pill,
   * then the trace beneath it. Anything laid out beside the column as a whole
   * gets centred against its full height, so expanding the trace floated the
   * context bar into the middle of the tool list. Inside the row, alignment is
   * structural and cannot drift.
   */
  trailing?: ReactNode;
}

/**
 * Ticks once a second while a turn is in flight.
 *
 * The clock is the whole point. A long tool call — a type-check, a build — can
 * run for minutes without changing the activity line, and a line that does not
 * move is indistinguishable from a dead conversation. A moving number says
 * "still going" without inventing anything.
 */
function useElapsed(since: number | null | undefined): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null || since === undefined) return;
    setNow(Date.now());
    const id = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return (): void => {
      clearInterval(id);
    };
  }, [since]);
  if (since === null || since === undefined) return null;
  return formatElapsed(now - since);
}

/** `just now`, `4m ago`, `2h ago` — the idle line's only number. */
function agoLabel(iso: string | null | undefined): string | null {
  if (iso === null || iso === undefined) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const secs = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (secs < 45) return 'just now';
  return `${formatElapsed(secs * 1000).split(' ')[0] ?? ''} ago`;
}

/**
 * The one place the chat says where it is, in every state.
 *
 * It exists because of the single failure this screen is never allowed to have:
 * looking finished while the agent is mid-turn. So it renders when idle too,
 * quietly — a strip that only appears while working cannot be trusted to be
 * absent for the right reason, and "nothing on screen" is exactly what a broken
 * indicator looks like.
 *
 * The working line says what a person would say — "Running the tests",
 * "Reading tokens.css" — beside a clock. Deliberately not playful: an invented
 * verb fills the silence without telling you anything.
 */
export function ChatStatusStrip({
  status,
  since,
  lastActivityAt,
  trace,
  live,
  expanded,
  onToggle,
  trailing,
}: ChatStatusStripProps): ReactElement {
  const elapsed = useElapsed(status === 'working' ? since : null);
  // Both settled states earn the timestamp: "Closed" and "Idle" each say that
  // nothing is happening, and how long ago it stopped is the one fact neither
  // word carries. The two live states have a clock or a tool name instead.
  const ago = status === 'idle' || status === 'done' ? agoLabel(lastActivityAt) : null;
  const latest = trace[trace.length - 1];

  // Working is the one state that can say something more specific than its own
  // name, because a tool call is a fact about what it is doing right now.
  //
  // The LIVE answer wins over the trace. They disagree for the length of a
  // turn — the trace only gains this turn's tools once the turn ends — and
  // during that stretch the trace's newest entry belongs to the PREVIOUS turn,
  // which is a worse answer than the one the server is holding.
  const running = live ?? latest;
  const label =
    status !== 'working'
      ? STATUS_LABEL[status]
      : running === undefined || running === null
        ? 'Thinking'
        : describeActivity(running.name, running.input);

  // Colour carries the state before the words do. Read from the same map the
  // rail and the project chip read, so there is one vocabulary and not three.
  const tone = STATUS_COLOR[status];

  const shown = trace.slice(-TRACE_LIMIT);
  const hidden = trace.length - shown.length;

  return (
    <div className="mt-1.5 flex flex-col items-start gap-1">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onToggle}
          disabled={trace.length === 0}
          title={
            trace.length === 0
              ? undefined
              : expanded
                ? 'Hide what the agent did'
                : 'Show what the agent is doing'
          }
          aria-expanded={trace.length === 0 ? undefined : expanded}
          aria-live="polite"
          className="flex w-fit items-center gap-2 rounded-full border border-border bg-surface-inset px-3 py-1.5 text-[length:var(--text-small)] text-text-secondary transition-colors enabled:hover:border-border-bright enabled:hover:text-text-primary disabled:cursor-default"
        >
          {/* The rail's own mark, not a second one that looks like it. Working
            throbs and radiates; awaiting is an open ring; idle is a quiet dot.
            Borrowing the class means the two surfaces cannot drift apart — a
            spinner here and a heartbeat there was two vocabularies for one
            state. Geometry stays with the rail row (see rail.css). */}
          <span aria-hidden className={`chat-status is-${status} shrink-0`}>
            <i />
          </span>
          <span
            className="font-medium"
            style={{ color: status === 'idle' ? 'var(--text-secondary)' : tone }}
          >
            {label}
          </span>
          {elapsed !== null ? (
            <span className="font-mono text-[length:var(--text-micro)] text-text-tertiary tabular-nums">
              {elapsed}
            </span>
          ) : null}
          {ago !== null ? (
            <span className="font-mono text-[length:var(--text-micro)] text-text-tertiary tabular-nums">
              {ago}
            </span>
          ) : null}
          {trace.length > 0 ? (
            <span
              aria-hidden
              className="font-mono text-[length:var(--text-micro)] text-text-tertiary"
            >
              {expanded ? '▾ hide' : '▸ details'}
            </span>
          ) : null}
        </button>
        {trailing}
      </div>

      {expanded && trace.length > 0 ? (
        <ol className="ml-3 flex flex-col gap-[0.1875rem] border-l border-border pl-3 font-mono text-[length:var(--text-small)]">
          {hidden > 0 ? (
            <li className="text-text-tertiary">
              + {hidden} earlier {hidden === 1 ? 'step' : 'steps'}
            </li>
          ) : null}
          {shown.map((call, i) => {
            // A tool with no duration yet has not reported back, so it is the
            // one still running. Nothing else in the payload says so.
            const done = call.durationMs !== undefined;
            const { verb, target } = traceLine(call.name, call.input);
            return (
              <li key={`${call.name}:${String(i)}`} className="flex items-baseline gap-2">
                <span
                  aria-hidden
                  className="w-3 shrink-0"
                  style={{ color: done ? 'var(--success)' : 'var(--text-tertiary)' }}
                >
                  {done ? '✓' : '·'}
                </span>
                <span className="w-16 shrink-0" style={{ color: done ? 'var(--success)' : tone }}>
                  {verb}
                </span>
                <span className="truncate text-text-secondary">{target}</span>
              </li>
            );
          })}
        </ol>
      ) : null}
    </div>
  );
}
