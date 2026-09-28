import { useState, type ReactElement } from 'react';
import type { SetChatModelBody } from '../../skills';
import { useChatModelPin } from '../../hooks/useChatModelPin';
import { Sheet, SheetRow } from './Sheet';

const SECTION_CLASS =
  'px-4 pt-3 pb-1 font-mono text-[10px] tracking-[0.06em] text-text-tertiary uppercase';

interface ModelSheetProps {
  open: boolean;
  onClose: () => void;
  conversationId: string;
}

/**
 * The chat's model and effort, pinned from its next turn — the desktop
 * context bar's picker as a sheet, on the same state (`useChatModelPin`).
 */
export function ModelSheet({ open, onClose, conversationId }: ModelSheetProps): ReactElement {
  return (
    <Sheet title="Model for this chat" open={open} onClose={onClose}>
      {open ? <ModelChoices conversationId={conversationId} /> : null}
    </Sheet>
  );
}

function ModelChoices({ conversationId }: { conversationId: string }): ReactElement {
  const pin = useChatModelPin(conversationId);
  const { chat, models, efforts, pinnedModel, pinnedEffort, providerName, saving, error } = pin;
  const [custom, setCustom] = useState('');

  if (chat === undefined) return <p className="mobile-note">Loading…</p>;
  const pick = (model: string | null, effort: SetChatModelBody['effort']): void => {
    void pin.save({ model, effort }).then(saved => {
      if (saved) setCustom('');
    });
  };

  return (
    <>
      <div className={SECTION_CLASS}>
        Model{providerName === undefined ? '' : ` · ${providerName}`}
      </div>
      <SheetRow
        checked={pinnedModel === null}
        onPick={() => {
          pick(null, pinnedEffort);
        }}
      >
        Default
      </SheetRow>
      {models.map(m => (
        <SheetRow
          key={m.value}
          checked={pinnedModel === m.value}
          onPick={() => {
            pick(m.value, pinnedEffort);
          }}
        >
          {m.value}
          {m.hint !== undefined ? <span className="text-text-tertiary"> — {m.hint}</span> : null}
        </SheetRow>
      ))}
      {pinnedModel !== null && !models.some(m => m.value === pinnedModel) ? (
        <SheetRow checked onPick={() => undefined}>
          {pinnedModel}
        </SheetRow>
      ) : null}
      <form
        className="flex gap-2 px-4 py-1"
        onSubmit={e => {
          e.preventDefault();
          const value = custom.trim();
          if (value !== '') pick(value, pinnedEffort);
        }}
      >
        <input
          value={custom}
          onChange={e => {
            setCustom(e.target.value);
          }}
          placeholder="Other model…"
          aria-label="Other model"
          autoComplete="off"
          autoCapitalize="off"
          className="min-h-11 min-w-0 flex-1 rounded-lg border border-border bg-surface-inset px-3 font-mono text-[16px] text-text-primary placeholder:text-text-tertiary"
        />
        <button type="submit" className="mobile-tap text-body text-text-secondary">
          Set
        </button>
      </form>
      {efforts.length > 0 ? (
        <>
          <div className={SECTION_CLASS}>Effort</div>
          <SheetRow
            checked={pinnedEffort === null}
            onPick={() => {
              pick(pinnedModel, null);
            }}
          >
            Default
          </SheetRow>
          {efforts.map(rung => (
            <SheetRow
              key={rung}
              checked={pinnedEffort === rung}
              onPick={() => {
                pick(pinnedModel, rung);
              }}
            >
              {rung}
            </SheetRow>
          ))}
        </>
      ) : null}
      {error !== null ? (
        <p role="alert" className="mobile-note text-error">
          {error}
        </p>
      ) : null}
      <p className="mobile-note">{saving ? 'Saving…' : 'This chat only, from the next turn.'}</p>
    </>
  );
}
