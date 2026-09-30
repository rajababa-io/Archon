/**
 * The notifications list (#289): chats awaiting you, then chats with a reply
 * you have not opened. Presentational and shared — the desktop rail's bell
 * panel and the phone's chat list draw the same rows from the same
 * `chatNotifications` output, so the two cannot describe a chat differently.
 *
 * Opening a row is the caller's (the desktop navigates with the ⌘K palette's
 * request, the phone to its chat path). Nothing here marks a chat read: the
 * chat screen does that when it is opened, which is the one rule both surfaces
 * already share (`useReadMarker`).
 */
import { useState, type ReactElement } from 'react';
import type { ChatNotification } from '../primitives/tab-signal';
import { relativeTime } from '../lib/format';

interface NotificationListProps {
  items: readonly ChatNotification[];
  projectLabel: (projectId: string) => string;
  onOpen: (item: ChatNotification) => void;
  onMarkAllRead: () => Promise<void>;
  /** Row and header sizing: the phone needs finger-sized rows. */
  touch?: boolean;
}

const GROUPS: readonly { kind: ChatNotification['kind']; label: string; color: string }[] = [
  { kind: 'awaiting', label: 'Waiting on you', color: 'var(--warning)' },
  { kind: 'unread', label: 'New reply', color: 'var(--accent-bright)' },
];

function what(item: ChatNotification): string {
  return item.kind === 'awaiting' ? 'waiting on your answer' : 'replied since you last looked';
}

export function NotificationList({
  items,
  projectLabel,
  onOpen,
  onMarkAllRead,
  touch = false,
}: NotificationListProps): ReactElement {
  const [marking, setMarking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const unread = items.filter(n => n.kind === 'unread').length;
  const pad = touch ? 'px-4' : 'px-3';

  const markAll = (): void => {
    setMarking(true);
    setFailure(null);
    onMarkAllRead()
      .catch((e: unknown) => {
        setFailure(`Some chats could not be marked read: ${String(e)}`);
      })
      .finally(() => {
        setMarking(false);
      });
  };

  return (
    <div className="flex flex-col">
      <div className={`flex items-center gap-2 ${pad} ${touch ? 'min-h-11' : 'py-2'}`}>
        <span className="flex-1 text-mini font-medium text-text-tertiary uppercase">
          Notifications
        </span>
        {unread > 0 ? (
          <button
            type="button"
            onClick={markAll}
            disabled={marking}
            className={`text-small text-accent-bright hover:underline disabled:opacity-50${
              touch ? ' mobile-tap' : ''
            }`}
          >
            Mark all read
          </button>
        ) : null}
      </div>
      {failure !== null ? (
        <p role="alert" className={`${pad} pb-2 text-small text-error`}>
          {failure}
        </p>
      ) : null}
      {items.length === 0 ? (
        <p className={`${pad} pb-3 text-small text-text-tertiary`}>Nothing needs you.</p>
      ) : (
        GROUPS.map(group => {
          const rows = items.filter(n => n.kind === group.kind);
          if (rows.length === 0) return null;
          return (
            <section key={group.kind} aria-label={group.label}>
              <h3
                className={`${pad} pt-1 pb-1 text-mini font-medium uppercase`}
                style={{ color: group.color }}
              >
                {group.label} · {rows.length}
              </h3>
              <ul>
                {rows.map(item => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => {
                        onOpen(item);
                      }}
                      className={`flex w-full items-start gap-2.5 ${pad} ${
                        touch ? 'min-h-14 py-2' : 'py-1.5'
                      } text-left hover:bg-surface-hover`}
                    >
                      <span
                        aria-hidden
                        className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
                        style={{ background: group.color }}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-body font-medium text-text-primary">
                          {item.title ?? 'Untitled chat'}
                        </span>
                        <span className="block truncate text-small text-text-tertiary">
                          {projectLabel(item.projectId)} · {what(item)}
                        </span>
                      </span>
                      {item.lastActivityAt !== null ? (
                        <span className="shrink-0 pt-0.5 text-mini text-text-tertiary">
                          {relativeTime(item.lastActivityAt)}
                        </span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })
      )}
    </div>
  );
}
