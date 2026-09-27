import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import * as skill from '../skills';
import type { ChatsConfig } from '../skills';
import { useEntity, invalidate } from '../store/cache';
import { K } from '../store/keys';
import { useCancelledRef } from '../lib/use-cancelled-ref';
import { SettingsSection } from './SettingsSection';
import { INPUT_CLASS, Switch } from './SettingsFormPrimitives';

/**
 * When a chat has grown enough to be worth moving out of.
 *
 * Install-wide, and the header chip says so without hedging. `chats` in a repo
 * `.archon/config.yaml` is merged and then read by nobody —
 * `resolveChatsConfig` is handed `loadConfig()` with no repo path — so a
 * project scope here would be a control with no wire, which is the defect this
 * whole settings pass exists to remove.
 *
 * All three rows are live. The mockup drew `autoHandoff` greyed and labelled
 * "not implemented", which was true when it was drawn; the auto-handoff path
 * shipped afterwards and reads this value on every turn.
 */
export function ChatsPanel(): ReactElement {
  const { data: config, error: configError } = useEntity(K.config, skill.getConfig);

  const [form, setForm] = useState<ChatsConfig | null>(null);
  const baselineRef = useRef('');
  useEffect(() => {
    if (config === undefined) return;
    // Typed as always present, and checked anyway: `K.config` is a shared
    // cache key, so this can be handed a payload from a server that predates
    // the field. Seeding `form` with `undefined` would pass a `=== null`
    // guard and then throw on the first read, taking the whole settings page
    // with it — a panel is allowed to be unavailable, not to crash its host.
    const chats: ChatsConfig | undefined = config.config.chats;
    if (chats === undefined) return;
    setForm(chats);
    baselineRef.current = JSON.stringify(chats);
  }, [config]);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const cancelledRef = useCancelledRef();

  if (configError !== undefined) {
    return (
      <SettingsSection title="Chats" scope="this install">
        <p className="text-small text-error">{configError.message}</p>
      </SettingsSection>
    );
  }
  if (form === null) {
    return (
      <SettingsSection title="Chats" scope="this install">
        <p className="text-small text-text-tertiary">Loading…</p>
      </SettingsSection>
    );
  }

  // The same rule the PATCH route enforces, said before the request rather
  // than after it. The server still checks — this is the explanation, not the
  // guard, and a form that only learns its rules from a 400 is a worse form.
  const orderError =
    form.nudgeAtPercent >= form.handoffAtPercent
      ? 'The nudge has to sit below the handoff point.'
      : null;
  const dirty = JSON.stringify(form) !== baselineRef.current;

  const onSave = async (): Promise<void> => {
    setSaving(true);
    setSaveError(null);
    try {
      await skill.updateChats(form);
      if (cancelledRef.current) return;
      invalidate(K.config);
    } catch (e: unknown) {
      if (cancelledRef.current) return;
      setSaveError(e instanceof Error ? e.message : 'Failed to save chat settings.');
    } finally {
      if (!cancelledRef.current) setSaving(false);
    }
  };

  return (
    <SettingsSection title="Chats" scope="this install">
      <p className="mb-2.5 text-body leading-relaxed text-text-tertiary">
        Percentages of the answering model&rsquo;s context window, not token counts — the same
        conversation is half full on one model and a tenth full on another. A chat whose model has
        no known window is never acted on.
      </p>

      <div className="flex flex-col divide-y divide-border">
        <Row
          title="Suggest wrapping up"
          description="One message, once. “Worth wrapping up soon; say the word and I’ll hand off.”"
        >
          <PercentField
            label="Suggest wrapping up at"
            value={form.nudgeAtPercent}
            onChange={n => {
              setForm(f => (f === null ? f : { ...f, nudgeAtPercent: n }));
            }}
          />
        </Row>

        <Row
          title="Say it is time to hand off"
          description="Stronger wording, and offers to write the handoff document. Must be above the first number."
        >
          <PercentField
            label="Hand off at"
            value={form.handoffAtPercent}
            onChange={n => {
              setForm(f => (f === null ? f : { ...f, handoffAtPercent: n }));
            }}
          />
        </Row>

        <Row
          title="Hand off automatically"
          description="Acts at that threshold instead of asking — but only at a safe boundary: the end of a turn, with no open question and no run waiting on you. At most twice per chat."
        >
          <Switch
            label="Hand off automatically"
            checked={form.autoHandoff}
            onChange={v => {
              setForm(f => (f === null ? f : { ...f, autoHandoff: v }));
            }}
          />
        </Row>
      </div>

      <ChatFillPreview nudge={form.nudgeAtPercent} handoff={form.handoffAtPercent} />

      <div className="mt-[11.5px] flex items-center justify-end gap-2.25">
        {orderError !== null ? <span className="text-small text-error">{orderError}</span> : null}
        {saveError !== null ? <span className="text-small text-error">{saveError}</span> : null}
        <button
          type="button"
          onClick={() => void onSave()}
          disabled={!dirty || saving || orderError !== null}
          className="brand-bar rounded-lg px-[14px] py-1.5 text-body font-medium text-white shadow-[0_8px_22px_-10px_color-mix(in_oklch,var(--accent),transparent_20%)] transition-all hover:-translate-y-px hover:brightness-110 disabled:translate-y-0 disabled:opacity-40 disabled:shadow-none"
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </SettingsSection>
  );
}

function Row({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="flex items-start gap-[13.5px] py-[8px]">
      <div className="min-w-0 flex-1">
        <div className="text-body font-medium text-text-primary">{title}</div>
        <div className="mt-[3px] text-body leading-relaxed text-text-tertiary">{description}</div>
      </div>
      <div className="shrink-0 pt-[2px]">{children}</div>
    </div>
  );
}

/**
 * A whole-percentage field.
 *
 * Holds its own text while focused so a field can pass through the empty
 * string on the way from `40` to `55` — writing the parsed number straight
 * back would make the first backspace resolve to `4` and fight the typing.
 */
function PercentField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}): ReactElement {
  const [text, setText] = useState<string | null>(null);
  return (
    <span className="relative inline-flex items-center">
      <input
        type="text"
        inputMode="numeric"
        aria-label={label}
        value={text ?? String(value)}
        onChange={e => {
          const next = e.target.value.replace(/[^0-9]/g, '').slice(0, 2);
          setText(next);
          const parsed = Number(next);
          if (next !== '' && Number.isFinite(parsed)) onChange(parsed);
        }}
        onBlur={() => {
          setText(null);
        }}
        className={`${INPUT_CLASS} w-[86px] pr-5.5 text-right`}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute right-[11px] text-body text-text-tertiary"
      >
        %
      </span>
    </span>
  );
}

/**
 * What the two numbers mean, drawn.
 *
 * "40" and "50" say nothing on their own about which one speaks first; the
 * band is the cheapest way to show that the quiet stretch is most of the
 * window and that the two thresholds are close together near the middle.
 */
export function ChatFillPreview({
  nudge,
  handoff,
}: {
  nudge: number;
  handoff: number;
}): ReactElement | null {
  if (nudge >= handoff) return null;
  return (
    <div className="mt-2.5">
      <div
        className="flex h-[9px] overflow-hidden rounded-full border"
        style={{ borderColor: 'var(--border)', background: 'var(--surface-inset)' }}
      >
        <span style={{ flex: `0 0 ${String(nudge)}%`, background: 'var(--success-soft)' }} />
        <span
          style={{ flex: `0 0 ${String(handoff - nudge)}%`, background: 'var(--warning-soft)' }}
        />
        <span style={{ flex: 1, background: 'var(--error-soft)' }} />
      </div>
      <div className="mt-[7px] flex justify-between text-mini font-medium text-text-tertiary">
        <span>0% — quiet</span>
        <span style={{ color: 'var(--warning)' }}>{nudge}% — nudge</span>
        <span style={{ color: 'var(--error)' }}>{handoff}% — hand off</span>
        <span>100%</span>
      </div>
      <p className="mt-[11px] text-body leading-relaxed text-text-tertiary">
        Each band speaks <b className="text-text-primary">once</b>. A fall — the provider compacted
        — re-arms it, so the next genuine crossing is heard. The defaults sit far below the
        window&rsquo;s ceiling on purpose: attention dilutes long before context fills.
      </p>
    </div>
  );
}
