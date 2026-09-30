import type { ReactElement } from 'react';
import { formatBytes } from '../primitives/file';
import { useImagePreviews } from '../hooks/useImagePreviews';

/**
 * What is attached to a message that has not been sent yet: one removable chip
 * per file, and the refusal line when something was left out.
 *
 * Shared by the composer and the ask card. Both attach to the same send, so a
 * file has to look and behave the same in both — a second copy of the chip
 * would be two places to change. An image carries a thumbnail so you can see
 * which picture rides the send; anything else is its name and size.
 *
 * Renders nothing at all when there is neither a file nor an error, so a caller
 * can mount it unconditionally.
 */
export function AttachedFiles(props: AttachedFilesProps): ReactElement {
  return <AttachedFilesView {...props} previews={useImagePreviews(props.files)} />;
}

interface AttachedFilesProps {
  files: File[];
  error: string | null;
  onRemove: (index: number) => void;
  /** Spacing belongs to the surface this sits on, not to the list. */
  className?: string;
}

/**
 * The chips themselves, given each file's preview URL (index-aligned, `null`
 * for a file with no picture). Split from the hook so the rendering is
 * testable without a DOM: the object URLs only exist in a browser.
 */
export function AttachedFilesView({
  files,
  previews,
  error,
  onRemove,
  className = '',
}: AttachedFilesProps & { previews: readonly (string | null)[] }): ReactElement {
  if (files.length === 0 && error === null) return <></>;
  return (
    <div className={className}>
      {files.length > 0 ? (
        <div className="flex flex-wrap gap-[0.375rem]">
          {files.map((f, i) => {
            const preview = previews[i] ?? null;
            return (
              <span
                key={`${f.name}-${String(i)}`}
                className={`flex items-center gap-[0.375rem] rounded-[var(--radius-card)] border bg-[color:var(--surface-elevated)] py-[0.25rem] pr-[5px] text-small ${preview !== null ? 'pl-[0.25rem]' : 'pl-[9px]'}`}
                style={{ borderColor: 'var(--border-bright)' }}
              >
                {preview !== null ? (
                  <img
                    src={preview}
                    alt={f.name}
                    className="h-[2.5rem] w-[2.5rem] shrink-0 rounded-[calc(var(--radius-card)-2px)] object-cover"
                  />
                ) : null}
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
            );
          })}
        </div>
      ) : null}
      {error !== null ? (
        <div className={`text-mini text-error${files.length > 0 ? ' mt-[8px]' : ''}`}>{error}</div>
      ) : null}
    </div>
  );
}
