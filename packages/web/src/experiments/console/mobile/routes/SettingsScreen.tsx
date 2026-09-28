import { useState, type ReactElement, type ReactNode } from 'react';
import * as skill from '../../skills';
import { invalidate, useEntity } from '../../store/cache';
import { K } from '../../store/keys';
import { errorDetail } from '../../lib/http';
import { curatedOptionsForAgent } from '../../lib/model-options';
import { setAppearance, useAppearance, type ThemeChoice } from '../../../../theme/appearance';
import { presetById } from '../../../../theme/presets';
import { ScreenHeader } from '../components/ScreenHeader';
import { SheetRow } from '../components/Sheet';

const PUSH_TRIGGERS = ['A chat needs you', 'A run finished', 'A run failed'] as const;

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

/** Drawn now, switched on when push notifications ship; nothing here subscribes yet. */
function PushSection(): ReactElement {
  return (
    <Section title="Notifications on this phone">
      <p className="px-4 pb-2 text-small text-text-tertiary">
        Push notifications are not available yet.
      </p>
      <div className="flex gap-2 px-4">
        <button
          type="button"
          disabled
          className="mobile-tap flex-1 rounded-lg border border-border text-body text-text-primary disabled:opacity-45"
        >
          Turn on
        </button>
        <button
          type="button"
          disabled
          className="mobile-tap flex-1 rounded-lg border border-border text-body text-text-primary disabled:opacity-45"
        >
          Send a test
        </button>
      </div>
      {PUSH_TRIGGERS.map(trigger => (
        <label
          key={trigger}
          className="mobile-row flex items-center gap-3 px-4 text-body text-text-primary opacity-45"
        >
          <span className="flex-1">{trigger}</span>
          <input type="checkbox" disabled className="size-5" />
        </label>
      ))}
    </Section>
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
          className="min-h-11 min-w-0 flex-1 rounded-lg border border-border bg-surface-inset px-3 font-mono text-[16px] text-text-primary placeholder:text-text-tertiary"
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
