import type { CSSProperties, ReactElement } from 'react';
import { TYPE_COLOR } from '../primitives/issue-board';

/**
 * A GitHub issue type — Bug, Task, Feature — as the prototype's `.chip.type`.
 *
 * A TINTED pill, not an outlined one. The distinction is the whole reason this
 * component exists: three chips outlined at full saturation sat in the board's
 * toolbar and became the loudest thing on the screen, which is what made the
 * Issues board read as a different design from the rest of the console.
 *
 * The prototype's values, kept exactly: a 30% border over a 12% fill, so the
 * hue identifies the type without competing with the issue titles it labels.
 */
export function IssueTypeChip({
  name,
  count,
  derived = false,
  dimmed = false,
  title,
  onClick,
}: {
  name: string;
  /** Shown after the name — the Overview's "TASK 28". */
  count?: number;
  /** Inferred from a legacy label rather than set as a GitHub type. */
  derived?: boolean;
  /** Another type is filtering the board, so this one recedes. */
  dimmed?: boolean;
  title?: string;
  onClick?: () => void;
}): ReactElement {
  const hue = TYPE_COLOR[name] ?? 'var(--text-secondary)';
  const known = TYPE_COLOR[name] !== undefined;
  const style: CSSProperties = {
    color: hue,
    // A dashed edge says "we worked this out from a label" without a second colour.
    border: `1px ${derived ? 'dashed' : 'solid'} ${
      known ? `color-mix(in oklch, ${hue}, transparent 70%)` : 'var(--border-bright)'
    }`,
    background: known ? `color-mix(in oklch, ${hue}, transparent 88%)` : 'transparent',
    opacity: dimmed ? 0.38 : 1,
  };
  const className =
    'inline-flex h-[17px] shrink-0 items-center gap-1 rounded-full px-[7px] text-mini font-medium';
  const body = (
    <>
      {name}
      {count === undefined ? null : <span className="opacity-70">{String(count)}</span>}
    </>
  );
  if (onClick === undefined) {
    return (
      <span className={className} style={style} title={title}>
        {body}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`${className} transition-opacity`}
      style={style}
    >
      {body}
    </button>
  );
}
