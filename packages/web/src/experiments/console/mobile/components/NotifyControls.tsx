import { useState, type ReactElement } from 'react';
import { Link } from 'react-router';
import { Bell, BellOff, BellRing } from 'lucide-react';
import { resolveChatMode } from '@archon/awaiting';
import type { PushDevice, PushPrefsChange } from '../../skills';
import { relativeTime } from '../../lib/format';
import { SETTINGS_PATH } from '../lib/paths';
import { usePushDevice, usePushDevices, usePushPrefs } from '../lib/use-push';
import { Sheet, SheetRow } from './Sheet';

type ChatMode = Extract<PushPrefsChange, { scope: 'conversation' }>['mode'];

const CHAT_MODES: readonly { mode: ChatMode; label: string; hint: string }[] = [
  { mode: 'default', label: 'Default', hint: 'When it needs you, and when its runs end' },
  { mode: 'following', label: 'Following', hint: 'Also every time it finishes a turn' },
  { mode: 'muted', label: 'Muted', hint: 'Nothing from this chat' },
];

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
  const own: ChatMode = prefs?.conversations[conversationId] ?? 'default';
  const effective =
    prefs === undefined ? 'default' : resolveChatMode(prefs, conversationId, projectId);
  const label = `Notifications: ${effective}`;

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
        {effective === 'following' ? (
          <BellRing aria-hidden className="h-5 w-5 text-accent-bright" />
        ) : effective === 'muted' ? (
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
        {own === 'default' && effective === 'muted' ? (
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

/**
 * The registered browsers, one row each: its label, when it was added, when a
 * push last got through, and Remove. Rows act on the server's id, never on a
 * label, so two browsers that read alike cannot be confused.
 */
export function PushDeviceRows({
  devices,
  thisDeviceId,
  removing,
  onRemove,
  now = Date.now(),
}: {
  devices: readonly PushDevice[];
  thisDeviceId: string | null;
  /** The id being removed, if any; every Remove waits for it. */
  removing: string | null;
  onRemove: (id: string) => void;
  now?: number;
}): ReactElement {
  if (devices.length === 0) {
    return <p className="mobile-note">No device has push on.</p>;
  }
  return (
    <ul aria-label="Devices with push on" className="flex flex-col">
      {devices.map(d => {
        const here = d.id === thisDeviceId;
        return (
          <li key={d.id} className="mobile-row flex items-center gap-3 px-4">
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-body text-text-primary">
                {d.label}
                {here ? <span className="text-accent-bright"> · this device</span> : null}
              </span>
              <span className="text-small text-text-tertiary">
                Added {relativeTime(d.created_at, now)} ·{' '}
                {d.last_success_at === null
                  ? 'no push has got through yet'
                  : `last push ${relativeTime(d.last_success_at, now)}`}
              </span>
            </div>
            <button
              type="button"
              disabled={removing !== null}
              aria-label={`Remove ${d.label}${here ? ' (this device)' : ''}`}
              onClick={() => {
                onRemove(d.id);
              }}
              className="mobile-tap shrink-0 text-body text-text-secondary disabled:opacity-45"
            >
              {removing === d.id ? 'Removing…' : 'Remove'}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Every browser registered for push, for Settings. Removing this device turns
 * push off here too: forgetting it on the server alone would be undone the
 * next time this browser reports the subscription it still holds.
 */
export function PushDevices({
  thisDeviceId,
  onRemoveThisDevice,
}: {
  thisDeviceId: string | null;
  onRemoveThisDevice: () => Promise<void>;
}): ReactElement {
  const { devices, error, removing, failure, remove } = usePushDevices();
  const [removingHere, setRemovingHere] = useState(false);
  if (error !== undefined) {
    return (
      <p className="mobile-note text-error">Couldn&apos;t list the devices: {error.message}</p>
    );
  }
  if (devices === undefined) return <p className="mobile-note">Loading devices…</p>;
  return (
    <>
      <PushDeviceRows
        devices={devices}
        thisDeviceId={thisDeviceId}
        removing={removingHere ? thisDeviceId : removing}
        onRemove={id => {
          if (id !== thisDeviceId) {
            void remove(id);
            return;
          }
          setRemovingHere(true);
          void onRemoveThisDevice().finally(() => {
            setRemovingHere(false);
          });
        }}
      />
      {failure !== null ? (
        <p role="alert" className="mobile-note text-error">
          {failure}
        </p>
      ) : null}
    </>
  );
}
