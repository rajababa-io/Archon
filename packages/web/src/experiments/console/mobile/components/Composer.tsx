import {
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type Ref,
} from 'react';
import type { ComposerControl } from '../../components/ChatComposer';

interface ComposerProps {
  onSend: (text: string) => void;
  /** A turn is running: what is sent now waits behind it. */
  working: boolean;
  /** Queue pull-back and focus, the same handle the desktop composer offers. */
  controlRef: Ref<ComposerControl>;
}

/** Tallest the box grows before it scrolls, so the transcript keeps some room. */
const MAX_HEIGHT_PX = 160;

/**
 * The message box and its Send button.
 *
 * Return inserts a newline, as it does in every phone messaging app; only the
 * button sends. While the agent works the button says Queue, because that is
 * what the server will do with the message.
 */
export function Composer({ onSend, working, controlRef }: ComposerProps): ReactElement {
  const [text, setText] = useState('');
  const boxRef = useRef<HTMLTextAreaElement | null>(null);

  useImperativeHandle(
    controlRef,
    () => ({
      restore: (restored: string): void => {
        setText(prev => (prev.trim() === '' ? restored : `${prev}\n${restored}`));
        boxRef.current?.focus();
      },
      focus: (): void => {
        boxRef.current?.focus();
      },
    }),
    []
  );

  // Grow with the text, measured after each change so the height is never a
  // frame behind what was typed.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (box === null) return;
    box.style.height = 'auto';
    box.style.height = `${String(Math.min(box.scrollHeight, MAX_HEIGHT_PX))}px`;
  }, [text]);

  const send = (): void => {
    const trimmed = text.trim();
    if (trimmed === '') return;
    onSend(trimmed);
    setText('');
  };

  return (
    <form
      className="mobile-composer flex items-end gap-2 border-t border-border bg-surface px-3 pt-2"
      onSubmit={e => {
        e.preventDefault();
        send();
      }}
    >
      <textarea
        ref={boxRef}
        value={text}
        onChange={e => {
          setText(e.target.value);
        }}
        rows={1}
        placeholder="Message the agent…"
        aria-label="Message"
        className="min-h-11 flex-1 resize-none rounded-lg border border-border bg-surface-inset px-3 py-2.5 text-[16px] leading-[1.4] text-text-primary outline-none placeholder:text-text-tertiary focus:border-border-bright"
      />
      <button
        type="submit"
        disabled={text.trim() === ''}
        className="mobile-tap brand-bar shrink-0 rounded-lg px-4 text-body font-medium text-white disabled:opacity-45"
      >
        {working ? 'Queue' : 'Send'}
      </button>
    </form>
  );
}
