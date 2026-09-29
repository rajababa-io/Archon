import { useState, type ReactElement } from 'react';
import type { SetChatModelBody } from '../skills';
import { pickerLabel, type LastTurn } from '../lib/chat-model';
import { useChatModelPin } from '../hooks/useChatModelPin';
import { MenuCheckItem, RowMenu } from './RowMenu';

const SECTION_CLASS =
  'px-2.5 pb-1 pt-2 font-mono text-[10px] uppercase tracking-[0.06em] text-text-tertiary';

/**
 * The model shown in the context bar, as a control (#132).
 *
 * Clicking it lists the models and effort rungs this chat's provider accepts —
 * both from the provider registry, never a list kept here — and picking one
 * pins it on this conversation. The pin applies from the next turn: a turn
 * already running resolved its model before the click and keeps it. Other
 * chats and every default are untouched.
 *
 * Free text stays available ("Other model…") because the SDKs ship models
 * faster than any list; the server checks it with the provider's own parser
 * and the refusal is shown here rather than swallowed.
 */
export function ChatModelPicker({
  conversationId,
  last,
}: {
  conversationId: string;
  /** What the last turn ran on, as the status line reports it. */
  last: LastTurn;
}): ReactElement {
  const {
    chat,
    models,
    efforts,
    pinnedModel,
    pinnedEffort,
    providerName,
    saving,
    error,
    clearError,
    save: savePin,
  } = useChatModelPin(conversationId);
  const pin = chat?.pin ?? null;
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState('');

  const save = async (body: Omit<SetChatModelBody, 'provider'>): Promise<void> => {
    if (await savePin(body)) setCustom('');
  };

  const title =
    pin === null
      ? 'Model for this chat — follows the default. Click to change.'
      : 'Model for this chat — set here, from the next turn. Click to change.';

  return (
    <>
      <button
        type="button"
        ref={setAnchor}
        // The menu closes on any pointerdown outside itself, and this button
        // is outside it: without this, a click meant to close would close and
        // then reopen.
        onPointerDown={e => {
          e.stopPropagation();
        }}
        onClick={() => {
          clearError();
          setOpen(v => !v);
        }}
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`truncate rounded font-mono text-[10.5px] underline decoration-dotted underline-offset-2 transition-colors hover:text-text-primary ${
          pin === null ? 'text-text-tertiary' : 'text-text-secondary'
        }`}
      >
        {pickerLabel(chat, last)}
      </button>
      <RowMenu
        anchor={anchor}
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        width={260}
        label="Model for this chat"
      >
        <div className={SECTION_CLASS}>
          Model{providerName === undefined ? '' : ` · ${providerName}`}
        </div>
        <MenuCheckItem
          label="Default"
          checked={pinnedModel === null}
          onSelect={() => {
            void save({ model: null, effort: pinnedEffort });
          }}
        />
        {models.map(m => (
          <MenuCheckItem
            key={m.value}
            label={m.hint === undefined ? m.value : `${m.value} — ${m.hint}`}
            checked={pinnedModel === m.value}
            onSelect={() => {
              void save({ model: m.value, effort: pinnedEffort });
            }}
          />
        ))}
        {pinnedModel !== null && !models.some(m => m.value === pinnedModel) ? (
          <MenuCheckItem label={pinnedModel} checked onSelect={() => undefined} />
        ) : null}
        <form
          className="px-2.5 py-1"
          onSubmit={e => {
            e.preventDefault();
            const value = custom.trim();
            if (value !== '') void save({ model: value, effort: pinnedEffort });
          }}
        >
          <input
            value={custom}
            onChange={e => {
              setCustom(e.target.value);
            }}
            placeholder="Other model… (Enter)"
            aria-label="Other model"
            autoComplete="off"
            className="w-full rounded border border-border bg-surface px-2 py-1 font-mono text-[11.5px] text-text-primary placeholder:text-text-tertiary"
          />
        </form>
        {efforts.length > 0 ? (
          <>
            <div className={SECTION_CLASS}>Effort</div>
            <MenuCheckItem
              label="Default"
              checked={pinnedEffort === null}
              onSelect={() => {
                void save({ model: pinnedModel, effort: null });
              }}
            />
            {efforts.map(rung => (
              <MenuCheckItem
                key={rung}
                label={rung}
                checked={pinnedEffort === rung}
                onSelect={() => {
                  void save({ model: pinnedModel, effort: rung });
                }}
              />
            ))}
          </>
        ) : null}
        {error !== null ? (
          <div
            role="alert"
            className="px-2.5 py-1.5 text-[11.5px]"
            style={{ color: 'var(--error)' }}
          >
            {error}
          </div>
        ) : null}
        <div
          className="border-t px-2.5 pb-1 pt-1.5 text-[11px] text-text-tertiary"
          style={{ borderColor: 'var(--border)' }}
        >
          {saving ? 'Saving…' : 'This chat only, from the next turn.'}
        </div>
      </RowMenu>
    </>
  );
}
