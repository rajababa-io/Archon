import { Fragment, useEffect, useRef, type ReactElement } from 'react';
import type { SlashMenuEntry } from '../lib/slash-menu';

interface SlashMenuProps {
  id: string;
  matches: SlashMenuEntry[];
  /** Show section headings — the unfiltered list, where order is by source. */
  grouped?: boolean;
  /** A line above the list, e.g. why the provider's commands are missing. */
  notice?: string | null;
  active: number;
  onHover: (index: number) => void;
  onChoose: (entry: SlashMenuEntry) => void;
}

export const slashOptionId = (menuId: string, index: number): string =>
  `${menuId}-option-${index.toString()}`;

/**
 * The composer's `/` menu, drawn above the input box. Presentational: the
 * composer's textarea keeps focus and drives the highlight through
 * `aria-activedescendant`, the way a combobox does.
 */
export function SlashMenu({
  id,
  matches,
  grouped = false,
  notice = null,
  active,
  onHover,
  onChoose,
}: SlashMenuProps): ReactElement {
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    listRef.current
      ?.querySelector(`#${CSS.escape(slashOptionId(id, active))}`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [id, active]);

  return (
    <ul
      ref={listRef}
      id={id}
      role="listbox"
      aria-label="Commands, skills and workflows"
      className="absolute bottom-full left-0 right-0 z-20 mb-[6px] max-h-[40vh] overflow-y-auto rounded-[var(--radius-panel)] border border-border bg-surface-elevated py-1 shadow-2xl"
    >
      {notice !== null ? (
        <li role="presentation" className="px-3 py-[0.375rem] text-small text-text-tertiary">
          {notice}
        </li>
      ) : null}
      {matches.map((entry, i) => {
        const selected = i === active;
        const heading = grouped && entry.group !== matches[i - 1]?.group ? entry.group : null;
        return (
          <Fragment key={entry.id}>
            {heading !== null ? (
              <li role="presentation" className="px-3 pb-0.5 pt-2 text-mini text-text-tertiary">
                {heading}
              </li>
            ) : null}
            <li
              id={slashOptionId(id, i)}
              role="option"
              aria-selected={selected}
              // mousedown, not click: the textarea must not lose focus, or the
              // composer commits its draft and the next keystroke goes nowhere.
              onMouseDown={e => {
                e.preventDefault();
                onChoose(entry);
              }}
              onMouseEnter={() => {
                onHover(i);
              }}
              className={`relative flex cursor-pointer items-baseline gap-2.25 px-3 py-[0.375rem] ${
                selected ? 'bg-surface-hover' : ''
              }`}
            >
              {selected ? (
                <span
                  aria-hidden
                  className="brand-bar pointer-events-none absolute bottom-1 left-0 top-1 w-0.5 rounded-full"
                />
              ) : null}
              <span className="shrink-0 text-body text-text-primary">
                {entry.label}
                {entry.args.length > 0 ? (
                  <span className="text-text-tertiary"> {entry.args}</span>
                ) : null}
              </span>
              <span className="min-w-0 truncate text-small text-text-secondary">
                {entry.description}
              </span>
              {entry.tag !== null ? (
                <span className="ml-auto shrink-0 rounded-sm bg-surface-hover px-1 py-0.5 text-mini text-text-tertiary">
                  {entry.tag}
                </span>
              ) : null}
            </li>
          </Fragment>
        );
      })}
    </ul>
  );
}
