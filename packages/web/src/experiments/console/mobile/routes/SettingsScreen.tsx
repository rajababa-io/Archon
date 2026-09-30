import { useState, type ReactElement, type ReactNode } from 'react';
import * as skill from '../../skills';
import { invalidate, useEntity } from '../../store/cache';
import { K } from '../../store/keys';
import { errorDetail } from '../../lib/http';
import { curatedOptionsForAgent } from '../../lib/model-options';
import {
  setAppearance,
  useAppearance,
  type TextSize,
  type ThemeChoice,
} from '../../../../theme/appearance';
import { presetById } from '../../../../theme/presets';
import { ScreenHeader } from '../components/ScreenHeader';
import { SheetRow } from '../components/Sheet';
import { InstallCoachMark } from '../components/InstallCoachMark';
import { PushDevices } from '../components/NotifyControls';
import { usePushDevice, usePushPrefs, type PushDeviceView } from '../lib/use-push';
import type { PushTriggers as PushTriggerSet } from '../../skills';

const THEMES: readonly { value: ThemeChoice; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

function Section({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <section aria-label={title} className="flex flex-col">
      <h2 className="px-4 pb-1 text-mini font-medium text-text-tertiary uppercase">{title}</h2>
      {children}
    </section>
  );
}

/**
 * `/m/settings` — the few settings that belong on a phone. Everything else
 * stays on the desktop console, which the last row opens.
 */
export function SettingsScreen(): ReactElement {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScreenHeader back="/m" backLabel="Back to chat" title="Settings" />
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto overscroll-contain py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <PushSection />
        <DefaultModelSection />
        <TextSizeSection />
        <ThemeSection />
        <Section title="Everything else">
          <a
            href="/console"
            className="mobile-row flex items-center px-4 text-body text-text-primary"
          >
            Open the desktop console
          </a>
        </Section>
      </div>
    </div>
  );
}

/**
 * Push on this device, every device registered, and the three things the
 * install pushes about. The list stands apart from this device's switch so a
 * phone that cannot take push here can still forget another one.
 */
function PushSection(): ReactElement {
  const device = usePushDevice();
  return (
    <Section title="Notifications">
      <PushDeviceControls device={device} />
      <PushDevices thisDeviceId={device.deviceId} onRemoveThisDevice={device.disable} />
      <PushTriggers />
    </Section>
  );
}

function PushDeviceControls({ device }: { device: PushDeviceView }): ReactElement {
  const { data: key, error } = useEntity(K.pushKey, skill.getPushKey);
  const [test, setTest] = useState<string | null>(null);

  if (error !== undefined) {
    return (
      <p className="mobile-note text-error">Couldn&apos;t read push settings: {error.message}</p>
    );
  }
  if (key === undefined) return <p className="mobile-note">Loading…</p>;
  if (!key.enabled) {
    return (
      <p role="status" className="mobile-note">
        Push is off on this server.{' '}
        {key.problem ?? `Set ${key.missing.join(', ')} in the server's environment.`}
      </p>
    );
  }
  if (device.availability === 'install-first') return <InstallCoachMark />;
  if (device.availability === 'unsupported') {
    return <p className="mobile-note">This browser can&apos;t receive push notifications.</p>;
  }
  if (device.availability === 'denied' && device.subscribed !== true) {
    return (
      <p className="mobile-note">
        Notifications are blocked for this site. Allow them in the browser&apos;s settings, then
        come back.
      </p>
    );
  }

  const sendTest = async (): Promise<void> => {
    setTest('Sending…');
    try {
      const result = await skill.sendTestPush();
      setTest(
        result.delivered > 0
          ? `Sent to ${String(result.delivered)} device${result.delivered === 1 ? '' : 's'}.`
          : 'No device accepted it.'
      );
    } catch (e) {
      setTest(`Couldn't send: ${errorDetail(e)}`);
    }
  };

  return (
    <>
      <p className="px-4 pb-2 text-small text-text-tertiary">
        {device.subscribed === null
          ? 'Checking this device…'
          : device.subscribed
            ? 'On for this device.'
            : 'Off for this device.'}
      </p>
      <div className="flex gap-2 px-4">
        {device.subscribed === true ? (
          <>
            <button
              type="button"
              onClick={() => void sendTest()}
              className="mobile-tap flex-1 rounded-lg border border-border text-body text-text-primary"
            >
              Send a test
            </button>
            <button
              type="button"
              disabled={device.busy}
              onClick={() => void device.disable()}
              className="mobile-tap flex-1 rounded-lg border border-border text-body text-text-secondary disabled:opacity-45"
            >
              Turn off
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={device.busy || device.subscribed === null}
            onClick={() => void device.enable(key.publicKey)}
            className="mobile-tap flex-1 rounded-lg border border-border text-body text-text-primary disabled:opacity-45"
          >
            Turn on
          </button>
        )}
      </div>
      {device.failure !== null ? (
        <p role="alert" className="mobile-note text-error">
          {device.failure}
        </p>
      ) : null}
      {test !== null ? (
        <p role="status" className="mobile-note">
          {test}
        </p>
      ) : null}
    </>
  );
}

const PUSH_TRIGGERS: readonly { key: keyof PushTriggerSet; label: string }[] = [
  { key: 'awaiting', label: 'A chat needs you' },
  { key: 'runFinished', label: 'A run finished' },
  { key: 'runFailed', label: 'A run failed' },
];

/** Install-wide: every subscribed device hears the same things. */
function PushTriggers(): ReactElement {
  const { prefs, error, saving, failure, change } = usePushPrefs();
  if (error !== undefined) {
    return (
      <p className="mobile-note text-error">
        Couldn&apos;t read what to notify about: {error.message}
      </p>
    );
  }
  return (
    <>
      {PUSH_TRIGGERS.map(trigger => (
        <label
          key={trigger.key}
          className="mobile-row flex items-center gap-3 px-4 text-body text-text-primary"
        >
          <span className="flex-1">{trigger.label}</span>
          <input
            type="checkbox"
            checked={prefs?.triggers[trigger.key] ?? false}
            disabled={prefs === undefined || saving}
            onChange={e => {
              void change({ scope: 'global', triggers: { [trigger.key]: e.target.checked } });
            }}
            className="size-5"
          />
        </label>
      ))}
      {failure !== null ? (
        <p role="alert" className="mobile-note text-error">
          {failure}
        </p>
      ) : null}
      <p className="mobile-note">
        For every device with push on. A chat or project can be muted, or a chat followed, from its
        bell.
      </p>
    </>
  );
}

/**
 * The model a new chat starts on: the install default assistant's model, the
 * same setting as Settings → Defaults on the desktop. A chat can still pick
 * its own from the composer.
 */
function DefaultModelSection(): ReactElement {
  const { data: config, error } = useEntity(K.config, skill.getConfig);
  const { data: providers } = useEntity(K.providers, skill.listProviders);
  const [custom, setCustom] = useState('');
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  if (error !== undefined) {
    return (
      <Section title="Default model for new chats">
        <p className="mobile-note text-error">Couldn&apos;t read the settings: {error.message}</p>
      </Section>
    );
  }
  if (config === undefined) {
    return (
      <Section title="Default model for new chats">
        <p className="mobile-note">Loading…</p>
      </Section>
    );
  }

  const assistant = config.config.assistant;
  const model = config.config.assistants[assistant]?.model;
  const current = typeof model === 'string' && model !== '' ? model : null;
  const options = curatedOptionsForAgent(assistant, providers);
  const providerName = providers?.find(p => p.id === assistant)?.displayName ?? assistant;

  const save = async (model: string): Promise<void> => {
    setSaving(true);
    setFailure(null);
    try {
      await skill.updateAssistantConfig({ assistant, assistants: { [assistant]: { model } } });
      invalidate(K.config);
      setCustom('');
    } catch (err) {
      setFailure(errorDetail(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section title="Default model for new chats">
      <p className="px-4 pb-1 text-small text-text-tertiary">
        {providerName} · now {current ?? 'the tier default'}
      </p>
      {options.map(option => (
        <SheetRow
          key={option.value}
          checked={current === option.value}
          disabled={saving}
          onPick={() => void save(option.value)}
        >
          {option.value}
          {option.hint !== undefined ? (
            <span className="text-text-tertiary"> — {option.hint}</span>
          ) : null}
        </SheetRow>
      ))}
      <form
        className="flex gap-2 px-4 py-1"
        onSubmit={e => {
          e.preventDefault();
          const value = custom.trim();
          if (value !== '') void save(value);
        }}
      >
        <input
          value={custom}
          onChange={e => {
            setCustom(e.target.value);
          }}
          placeholder="Other model…"
          aria-label="Other default model"
          autoComplete="off"
          autoCapitalize="off"
          className="min-h-11 min-w-0 flex-1 rounded-lg border border-border bg-surface-inset px-3 font-mono mobile-input text-text-primary placeholder:text-text-tertiary"
        />
        <button
          type="submit"
          disabled={saving}
          className="mobile-tap text-body text-text-secondary"
        >
          Set
        </button>
      </form>
      {failure !== null ? (
        <p role="alert" className="mobile-note text-error">
          {failure}
        </p>
      ) : null}
      <p className="mobile-note">For every new chat on this install.</p>
    </Section>
  );
}

/** Smallest to largest — the slider's order. Labels are what a screen reader says. */
const TEXT_SIZES: readonly { value: TextSize; label: string }[] = [
  { value: 'xs', label: 'Extra small' },
  { value: 's', label: 'Small' },
  { value: 'm', label: 'Default' },
  { value: 'l', label: 'Large' },
  { value: 'xl', label: 'Extra large' },
];

/**
 * Telegram's Text Size: a slider between a small A and a big A, with a
 * message under it that changes as it moves. The whole phone UI resizes live,
 * so the preview is the screen itself as much as the sample bubble.
 */
function TextSizeSection(): ReactElement {
  const { text } = useAppearance();
  const index = Math.max(
    0,
    TEXT_SIZES.findIndex(s => s.value === text)
  );
  return (
    <Section title="Text size">
      <div className="flex items-center gap-3 px-4">
        <span aria-hidden="true" className="text-small text-text-tertiary">
          A
        </span>
        <input
          type="range"
          min={0}
          max={TEXT_SIZES.length - 1}
          step={1}
          value={index}
          aria-label="Text size"
          aria-valuetext={TEXT_SIZES[index]?.label}
          onChange={e => {
            const next = TEXT_SIZES[Number(e.target.value)];
            if (next !== undefined) setAppearance({ text: next.value });
          }}
          className="mobile-tap flex-1 accent-accent"
        />
        <span aria-hidden="true" className="text-title text-text-tertiary">
          A
        </span>
      </div>
      <div className="mx-4 mt-2 flex flex-col gap-1 rounded-xl border border-border bg-surface-inset p-3">
        <p className="self-end rounded-2xl bg-surface-hover px-3 py-2 text-body text-text-primary">
          Is this easy to read?
        </p>
        <p className="self-start rounded-2xl bg-surface px-3 py-2 text-body text-text-primary">
          {TEXT_SIZES[index]?.label} — every screen on this phone uses this size.
        </p>
      </div>
      <p className="mobile-note">This phone only. The desktop has its own.</p>
    </Section>
  );
}

function ThemeSection(): ReactElement {
  const { theme } = useAppearance();
  const other = THEMES.some(t => t.value === theme)
    ? null
    : theme === 'custom'
      ? 'Custom'
      : (presetById(theme)?.label ?? theme);
  return (
    <Section title="Theme">
      <div role="group" aria-label="Theme" className="flex gap-2 px-4">
        {THEMES.map(t => (
          <button
            key={t.value}
            type="button"
            aria-pressed={theme === t.value}
            onClick={() => {
              setAppearance({ theme: t.value });
            }}
            className="mobile-tap flex-1 rounded-lg border border-border text-body text-text-secondary aria-pressed:bg-surface-hover aria-pressed:text-text-primary"
          >
            {t.label}
          </button>
        ))}
      </div>
      {other !== null ? <p className="mobile-note">Now {other}, chosen on the desktop.</p> : null}
    </Section>
  );
}
