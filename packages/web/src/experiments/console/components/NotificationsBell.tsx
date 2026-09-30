/**
 * The rail's Notifications row and its panel (#289). The count is the favicon
 * badge's number — both read `useNotifications` — and the panel is the list
 * that number is made of, so the badge is never a number with nothing behind
 * it.
 *
 * The panel opens beside the rail rather than under the row: the rail is
 * narrow, and a list of chat titles squeezed into it would truncate to
 * nothing.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import { Bell } from 'lucide-react';
import * as skill from '../skills';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';
import type { Project } from '../primitives/project';
import { badgeText, type ChatNotification } from '../primitives/tab-signal';
import { getDisplayName, projectLabel } from '../lib/display-name';
import type { OpenChatRequest } from '../lib/open-chat';
import { markAllRead, useNotifications } from '../lib/use-notifications';
import { NotificationList } from './NotificationList';

const PANEL_WIDTH = 380;
const MARGIN = 8;

export function NotificationsBell(): ReactElement {
  const { items, loaded } = useNotifications();
  const [open, setOpen] = useState(false);
  const rowRef = useRef<HTMLButtonElement | null>(null);
  const close = useCallback((): void => {
    setOpen(false);
  }, []);
  const count = items.length;
  const label =
    count > 0 ? `Notifications, ${String(count)} need you` : 'Notifications, nothing needs you';

  return (
    <>
      <button
        ref={rowRef}
        type="button"
        onClick={() => {
          setOpen(o => !o);
        }}
        title="Notifications"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="rail-row"
      >
        <span
          aria-hidden
          className="rail-ico relative"
          style={{ color: count > 0 ? 'var(--accent-bright)' : 'var(--text-tertiary)' }}
        >
          <Bell />
        </span>
        <span className="rail-hide rail-text">Notifications</span>
        {loaded && count > 0 ? (
          <span
            aria-hidden
            className="rail-hide shrink-0 rounded-full px-1.5 text-mini leading-4 font-medium"
            style={{ background: 'var(--accent)', color: 'white' }}
          >
            {badgeText(count)}
          </span>
        ) : null}
      </button>
      {open ? <NotificationsPanel anchor={rowRef.current} items={items} onClose={close} /> : null}
    </>
  );
}

function NotificationsPanel({
  anchor,
  items,
  onClose,
}: {
  anchor: HTMLElement | null;
  items: readonly ChatNotification[];
  onClose: () => void;
}): ReactElement {
  const navigate = useNavigate();
  const { data: projects } = useEntity<Project[]>(K.projects, skill.listProjects);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const place = (): void => {
      if (anchor === null) return;
      const rect = anchor.getBoundingClientRect();
      const width = Math.min(PANEL_WIDTH, window.innerWidth - 2 * MARGIN);
      setAt({
        top: Math.max(MARGIN, rect.top),
        left: Math.min(rect.right + MARGIN, window.innerWidth - MARGIN - width),
      });
    };
    place();
    window.addEventListener('resize', place);
    return (): void => {
      window.removeEventListener('resize', place);
    };
  }, [anchor]);

  useEffect(() => {
    const onPointer = (e: MouseEvent): void => {
      const t = e.target as Node | null;
      if (t === null) return;
      // The row toggles the panel itself; closing here too would reopen it.
      if (panelRef.current?.contains(t) === true || anchor?.contains(t) === true) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return (): void => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchor, onClose]);

  const label = (projectId: string): string => {
    const name = projects?.find(p => p.id === projectId)?.name ?? projectId;
    return projectLabel(name, getDisplayName(projectId, name));
  };

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Notifications"
      className="console-root fixed z-[1000] max-h-[70vh] overflow-y-auto rounded-[10px] border py-1 text-text-primary shadow-[0_14px_30px_rgba(0,0,0,0.45)]"
      style={{
        top: at?.top ?? 0,
        left: at?.left ?? 0,
        width: `min(${String(PANEL_WIDTH)}px, calc(100vw - ${String(2 * MARGIN)}px))`,
        background: 'var(--surface-elevated)',
        borderColor: 'var(--border-bright)',
        visibility: at === null ? 'hidden' : undefined,
      }}
    >
      <NotificationList
        items={items}
        projectLabel={label}
        onOpen={item => {
          // The chat's own project, which need not be the one on screen — the
          // same request a desktop notification's click makes.
          const request: OpenChatRequest = { openChat: item.id, done: item.completed };
          navigate(`/console/p/${item.projectId}/chat`, { state: request });
          onClose();
        }}
        onMarkAllRead={() => markAllRead(items)}
      />
    </div>,
    document.body
  );
}
