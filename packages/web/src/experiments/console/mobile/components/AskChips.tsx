import type { ReactElement } from 'react';
import type { AskSpec } from '@archon/awaiting';
import { isComplete } from '../../primitives/ask';
import { currentQuestion, type ChipState } from '../lib/ask-chips';

interface AskChipsProps {
  spec: AskSpec;
  state: ChipState;
  onTap: (label: string) => void;
  /** Done choosing on a multi-answer question. */
  onConfirm: () => void;
  /** "Other…": answer this question in the message box. */
  onOther: () => void;
  /** "Other…" was tapped and the box is waiting for the answer. */
  answeringOwn: boolean;
}

/**
 * The open question's options, one tap each, above the keys. Several
 * questions are shown one at a time, and the set is sent once every one has an
 * answer — the same message the ask card in the transcript would send.
 */
export function AskChips({
  spec,
  state,
  onTap,
  onConfirm,
  onOther,
  answeringOwn,
}: AskChipsProps): ReactElement | null {
  const question = currentQuestion(spec, state);
  if (question === undefined) return null;
  const chosen = state.answers[state.index] ?? [];
  const multi = question.multi === true;
  const total = spec.questions.length;

  return (
    <section aria-label="Answer the question" className="shrink-0 px-3 pt-2">
      <p className="truncate text-small text-text-tertiary">
        {total > 1 ? `${String(state.index + 1)}/${String(total)} · ` : ''}
        {question.title}
      </p>
      <div className="flex gap-2 overflow-x-auto overscroll-x-contain py-1.5">
        {question.options.map(option => {
          const on = chosen.includes(option.label);
          return (
            <button
              key={option.label}
              type="button"
              aria-pressed={on}
              onPointerDown={e => {
                e.preventDefault();
              }}
              onClick={() => {
                onTap(option.label);
              }}
              className={`mobile-tap shrink-0 rounded-full border px-4 text-body whitespace-nowrap ${
                on
                  ? 'border-accent bg-[color:color-mix(in_oklch,var(--accent),transparent_80%)] text-text-primary'
                  : 'border-border-bright text-text-secondary'
              }`}
            >
              {option.recommended === true ? (
                <span aria-label="recommended" className="mr-1 text-accent-bright">
                  ★
                </span>
              ) : null}
              {option.label}
            </button>
          );
        })}
        {question.allowOwn !== false ? (
          <button
            type="button"
            aria-pressed={answeringOwn}
            onClick={onOther}
            className="mobile-tap shrink-0 rounded-full border border-dashed border-border-bright px-4 text-body whitespace-nowrap text-text-secondary"
          >
            Other…
          </button>
        ) : null}
        {multi ? (
          <button
            type="button"
            disabled={chosen.length === 0}
            onPointerDown={e => {
              e.preventDefault();
            }}
            onClick={onConfirm}
            className="mobile-tap brand-bar shrink-0 rounded-full px-4 text-body font-medium text-white disabled:opacity-45"
          >
            {isComplete(spec.questions, state.answers) ? 'Send' : 'Next'}
          </button>
        ) : null}
      </div>
    </section>
  );
}
