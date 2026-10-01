import { Paperclip } from 'lucide-react';
import type { ReactElement } from 'react';
import { formatBytes } from '../primitives/file';
import type { MessageFile } from '../primitives/message';

/**
 * Attachments on a user's bubble — sent, or queued behind the running turn.
 *
 * An image the server kept a copy of shows as a thumbnail that opens full size
 * (#318) — a screenshot is the context of the question asked about it.
 *
 * Anything else is a chip, deliberately not a link. The upload is ephemeral —
 * the server deletes it once the agent has read it and never serves it — so
 * there is nothing to open. The tooltip says so, because a chip that looks
 * like a file and does nothing reads as a broken link.
 */
export function FileChips({
  files,
  queued = false,
}: {
  files: readonly MessageFile[];
  /** Not read by the agent yet, so the chip's tooltip cannot say it was. */
  queued?: boolean;
}): ReactElement {
  const chipNote = queued
    ? 'Waiting with this message — the agent reads it when the message is delivered.'
    : 'Sent to the agent. The file was deleted from the server once it was read — this is a record of the upload, not a copy of it.';
  return (
    <div className="flex flex-wrap justify-end gap-[0.375rem]">
      {files.map((f, i) =>
        f.imageUrl !== null ? (
          <a
            key={`${f.name}-${String(i)}`}
            href={f.imageUrl}
            target="_blank"
            rel="noreferrer"
            title={`${f.name} · ${formatBytes(f.size)} — open full size`}
            className="block overflow-hidden rounded-[var(--radius-card)] border border-border-bright bg-[color:var(--surface-elevated)]"
          >
            <img
              src={f.imageUrl}
              alt={f.name}
              loading="lazy"
              className="block max-h-[12rem] max-w-[16rem] object-contain"
            />
          </a>
        ) : (
          <span
            key={`${f.name}-${String(i)}`}
            title={`${f.name} · ${formatBytes(f.size)}\n${chipNote}`}
            className="flex items-center gap-[0.375rem] rounded-[var(--radius-card)] border border-border-bright bg-[color:var(--surface-elevated)] px-[0.5rem] py-[0.2rem] text-mini"
          >
            <Paperclip aria-hidden className="h-[0.75rem] w-[0.75rem] text-text-tertiary" />
            <span className="max-w-[180px] truncate text-text-secondary">{f.name}</span>
            <span className="text-text-tertiary">{formatBytes(f.size)}</span>
          </span>
        )
      )}
    </div>
  );
}
