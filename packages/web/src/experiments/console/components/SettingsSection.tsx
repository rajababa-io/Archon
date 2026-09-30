import type { ReactElement, ReactNode } from 'react';

/**
 * Shared card shell for the console settings panels (Assistant, System, …).
 *
 * The prototype's `.panel`: a bordered card on the elevated surface with a
 * header BAND rather than a heading floating in the body. The band is what
 * makes a column of eight panels scan as eight things — without it the titles
 * and the fields below them read as one continuous list.
 *
 * `overflow-hidden` is load-bearing: the header's bottom border has to stop at
 * the card's rounded corner, not run past it.
 */
export function SettingsSection({
  title,
  scope,
  children,
}: {
  title: string;
  /** Optional header chip, e.g. the config scope a panel writes to. */
  scope?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <section className="overflow-hidden rounded-lg border bg-surface-elevated">
      <header className="flex items-center gap-[9px] border-b px-[11px] py-[7px]">
        <h2 className="text-large font-medium leading-[1.55] text-text-primary">{title}</h2>
        {scope !== undefined ? (
          <span className="rounded-[4px] bg-[color:var(--surface-bright,var(--surface-hover))] px-[7px] py-[2px] text-small text-text-secondary">
            {scope}
          </span>
        ) : null}
      </header>
      <div className="px-[11px] py-1.75">{children}</div>
    </section>
  );
}
