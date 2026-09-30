import type { ReactElement } from 'react';
import { X } from 'lucide-react';
import { formatBytes } from '../../primitives/file';
import { useImagePreviews } from '../../hooks/useImagePreviews';

interface AttachmentTrayProps {
  files: readonly File[];
  error: string | null;
  /** Images still being shrunk before they can join the list. */
  preparing: number;
  onRemove: (index: number) => void;
}

/**
 * What rides the next message: a thumbnail for each picture, a name for
 * anything else, each removable. Renders nothing when there is nothing to say.
 */
export function AttachmentTray({
  files,
  error,
  preparing,
  onRemove,
}: AttachmentTrayProps): ReactElement | null {
  const previews = useImagePreviews(files);

  if (files.length === 0 && error === null && preparing === 0) return null;
  return (
    <section aria-label="Attachments" className="shrink-0 px-3 pt-2">
      <ul className="flex gap-2 overflow-x-auto pb-1">
        {files.map((file, i) => {
          const preview = previews[i] ?? null;
          return (
            <li
              key={`${file.name}-${String(i)}`}
              className="relative h-16 shrink-0 overflow-hidden rounded-lg border border-border-bright bg-surface-inset"
            >
              {preview !== null ? (
                <img src={preview} alt={file.name} className="h-16 w-16 object-cover" />
              ) : (
                <span className="flex h-16 w-28 flex-col justify-center px-2 text-small">
                  <span className="truncate text-text-primary">{file.name}</span>
                  <span className="text-mini text-text-tertiary">{formatBytes(file.size)}</span>
                </span>
              )}
              <button
                type="button"
                aria-label={`Remove ${file.name}`}
                onClick={() => {
                  onRemove(i);
                }}
                className="mobile-tap absolute top-0 right-0 flex items-start justify-end"
              >
                <span className="flex h-6 w-6 items-center justify-center rounded-bl-lg bg-black/60 text-white">
                  <X aria-hidden className="h-4 w-4" />
                </span>
              </button>
            </li>
          );
        })}
        {preparing > 0 ? (
          <li className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg border border-dashed border-border-bright text-mini text-text-tertiary">
            Shrinking…
          </li>
        ) : null}
      </ul>
      {error !== null ? <p className="text-mini text-error">{error}</p> : null}
    </section>
  );
}
