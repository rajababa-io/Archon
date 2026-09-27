import type { ReactElement } from 'react';
import { STATUS_COLOR } from '../primitives/chat-status';
import type { ChecklistItem, ChecklistStatus } from '../primitives/checklist';

interface TurnChecklistProps {
  items: readonly ChecklistItem[];
}

/** One mark per state, coloured from the vocabulary the rail already uses. */
const MARK: Readonly<Record<ChecklistStatus, { glyph: string; color: string; label: string }>> = {
  completed: { glyph: '✓', color: STATUS_COLOR.done, label: 'done' },
  in_progress: { glyph: '●', color: STATUS_COLOR.working, label: 'in progress' },
  pending: { glyph: '○', color: 'var(--text-tertiary)', label: 'not started' },
};

/**
 * The agent's own to-do list for this turn, as it last wrote it.
 *
 * Shown open rather than behind a toggle: it is short, and its whole value is
 * being seen while the turn runs — a plan heading the wrong way is cheapest to
 * stop before the work starts, not after.
 */
export function TurnChecklist({ items }: TurnChecklistProps): ReactElement | null {
  if (items.length === 0) return null;
  const done = items.filter(i => i.status === 'completed').length;
  return (
    <section
      aria-label="Agent's to-do list"
      className="mt-2 w-fit max-w-[74ch] min-w-[16rem] rounded-[var(--radius-card)] border border-border bg-surface-inset px-3 py-2"
    >
      <header className="mb-1 flex items-baseline gap-2 text-mini text-text-tertiary">
        <span className="font-medium">To-do</span>
        <span className="tabular-nums">
          {done} of {items.length} done
        </span>
      </header>
      <ol className="flex flex-col gap-[0.1875rem] text-small">
        {items.map(item => {
          const mark = MARK[item.status];
          return (
            <li key={item.id} className="flex items-baseline gap-2">
              <span aria-hidden className="w-3 shrink-0" style={{ color: mark.color }}>
                {mark.glyph}
              </span>
              <span className="sr-only">{mark.label}: </span>
              <span
                className={
                  item.status === 'completed'
                    ? 'text-text-tertiary line-through'
                    : item.status === 'in_progress'
                      ? 'font-medium text-text-primary'
                      : 'text-text-secondary'
                }
              >
                {item.text}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
