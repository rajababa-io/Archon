import { useState, type ReactElement } from 'react';
import { Link } from 'react-router';
import { Bell, BellOff, BellRing } from 'lucide-react';
import type { PushPrefs } from '../../skills';
import { SETTINGS_PATH } from '../lib/paths';
import { usePushDevice, usePushPrefs } from '../lib/use-push';
import { Sheet, SheetRow } from './Sheet';

type ChatMode = 'default' | 'muted' | 'following';

const CHAT_MODES: readonly { mode: ChatMode; label: string; hint: string }[] = [
  { mode: 'default', label: 'Default', hint: 'When it needs you, and when its runs end' },
  { mode: 'following', label: 'Following', hint: 'Also every time it finishes a turn' },
  { mode: 'muted', label: 'Muted', hint: 'Nothing from this chat' },
];

/** What a chat's bell shows: its own mode, or muted when its project is. */
function chatBell(
  prefs: PushPrefs | undefined,
  conversationId: string,
  projectId: string | null
): { own: ChatMode; projectMuted: boolean } {
  const own = prefs?.conversations[conversationId] ?? 'default';
  const projectMuted = projectId !== null && (prefs?.mutedProjects.includes(projectId) ?? false);
  return { own, projectMuted };
}

/** One line when push is not on for this device: the bell alone would reach nobody here. */
function DeviceNote(): ReactElement | null {
  const device = usePushDevice();
  if (device.subscribed !== false) return null;
  return (
    <p className="mobile-note">
      Push is off on this device.{' '}
      <Link to={SETTINGS_PATH} className="text-accent-bright underline underline-offset-2">
        Turn it on in Settings
      </Link>
    </p>
  );
}

/** The chat header's bell: Default, Following or Muted for this one chat. */
export function ChatBell({
  conversationId,
  projectId,
}: {
  conversationId: string;
  projectId: string | null;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const { prefs, saving, failure, change } = usePushPrefs();
  const { own, projectMuted } = chatBell(prefs, conversationId, projectId);
  const silent = own === 'muted' || (own === 'default' && projectMuted);
  const label =
    own === 'following'
      ? 'Notifications: following'
      : silent
        ? 'Notifications: muted'
        : 'Notifications: default';

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
        aria-label={label}
        disabled={prefs === undefined}
        className="mobile-tap flex shrink-0 items-center justify-center text-text-secondary disabled:opacity-45"
      >
        {own === 'following' ? (
          <BellRing aria-hidden className="h-5 w-5 text-accent-bright" />
        ) : silent ? (
          <BellOff aria-hidden className="h-5 w-5" />
        ) : (
          <Bell aria-hidden className="h-5 w-5" />
        )}
      </button>
      <Sheet
        title="Notifications for this chat"
        open={open}
        onClose={() => {
          setOpen(false);
        }}
      >
        {CHAT_MODES.map(m => (
          <SheetRow
            key={m.mode}
            checked={own === m.mode}
            disabled={saving}
            onPick={() => {
              void change({ scope: 'conversation', id: conversationId, mode: m.mode });
            }}
          >
            {m.label}
            <span className="block text-small text-text-tertiary">{m.hint}</span>
          </SheetRow>
        ))}
        {projectMuted && own === 'default' ? (
          <p className="mobile-note">
            This chat&apos;s project is muted, so Default sends nothing.
          </p>
        ) : null}
        {failure !== null ? (
          <p role="alert" className="mobile-note text-error">
            {failure}
          </p>
        ) : null}
        <DeviceNote />
      </Sheet>
    </>
  );
}

/** The project screen's mute: silences every chat in it that has no mode of its own. */
export function ProjectMute({ projectId }: { projectId: string }): ReactElement {
  const { prefs, saving, failure, change } = usePushPrefs();
  const muted = prefs?.mutedProjects.includes(projectId) ?? false;
  return (
    <button
      type="button"
      aria-pressed={muted}
      aria-label={muted ? 'Unmute this project' : 'Mute this project'}
      title={failure ?? undefined}
      disabled={prefs === undefined || saving}
      onClick={() => {
        void change({ scope: 'project', id: projectId, mode: muted ? 'default' : 'muted' });
      }}
      className={`mobile-tap flex items-center justify-center disabled:opacity-45 ${
        failure !== null ? 'text-error' : 'text-text-secondary'
      }`}
    >
      {muted ? (
        <BellOff aria-hidden className="h-5 w-5" />
      ) : (
        <Bell aria-hidden className="h-5 w-5" />
      )}
    </button>
  );
}
