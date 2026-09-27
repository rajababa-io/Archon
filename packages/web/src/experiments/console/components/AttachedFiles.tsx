import type { ReactElement } from 'react';
import { formatBytes } from '../primitives/file';

/**
 * What is attached to a message that has not been sent yet: one removable chip
 * per file, and the refusal line when something was left out.
 *
 * Shared by the composer and the ask card. Both attach to the same send, so a
 * file has to look and behave the same in both — a second copy of the chip
 * would be two places to change the day a chip gains a thumbnail or a type
 * icon.
 *
 * Renders nothing at all when there is neither a file nor an error, so a caller
 * can mount it unconditionally.
 */
export function AttachedFiles({
  files,
  error,
  onRemove,
  className = '',
}: {
  files: File[];
  error: string | null;
  onRemove: (index: number) => void;
  /** Spacing belongs to the surface this sits on, not to the list. */
  className?: string;
}): ReactElement {
  if (files.length === 0 && error === null) return <></>;
  return (
    <div className={className}>
      {files.length > 0 ? (
        <div className="flex flex-wrap gap-[0.375rem]">
          {files.map((f, i) => (
            <span
              key={`${f.name}-${String(i)}`}
              className="flex items-center gap-[0.375rem] rounded-[var(--radius-card)] border bg-[color:var(--surface-elevated)] py-[0.25rem] pl-[9px] pr-[5px] text-small"
              style={{ borderColor: 'var(--border-bright)' }}
            >
              <span className="max-w-[180px] truncate text-text-primary">{f.name}</span>
              <span className="text-mini text-text-tertiary">{formatBytes(f.size)}</span>
              <button
                type="button"
                onClick={() => {
                  onRemove(i);
                }}
                aria-label={`Remove ${f.name}`}
                className="rounded p-[0.0625rem] text-text-tertiary transition-colors hover:bg-[color:var(--surface-hover)] hover:text-text-primary"
              >
                <span aria-hidden className="text-mini leading-none">
                  ✕
                </span>
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {error !== null ? (
        <div className={`text-mini text-error${files.length > 0 ? ' mt-[8px]' : ''}`}>{error}</div>
      ) : null}
    </div>
  );
}
