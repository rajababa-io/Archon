import { useEffect, useRef, type ReactElement } from 'react';
import { useSwipe } from '../lib/gesture';

interface FullScreenEditorProps {
  value: string;
  onChange: (value: string) => void;
  onClose: () => void;
  onSend: () => void;
  /** Send's label, as the composer shows it. */
  sendLabel: string;
  canSend: boolean;
}

/**
 * The draft with the whole screen to itself, for a message longer than the
 * composer's few lines. The same text as the composer — closing keeps it.
 */
export function FullScreenEditor({
  value,
  onChange,
  onClose,
  onSend,
  sendLabel,
  canSend,
}: FullScreenEditorProps): ReactElement {
  const boxRef = useRef<HTMLTextAreaElement | null>(null);
  const headerRef = useRef<HTMLElement | null>(null);
  useSwipe(headerRef, swipe => {
    if (swipe === 'down') onClose();
  });

  useEffect(() => {
    const box = boxRef.current;
    if (box === null) return;
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  }, []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Full-screen editor"
      className="absolute inset-0 z-40 flex flex-col bg-surface"
    >
      <header
        ref={headerRef}
        className="mobile-safe-top flex shrink-0 items-center justify-between gap-2 border-b border-border px-2 pb-1"
      >
        <button
          type="button"
          onClick={onClose}
          className="mobile-tap px-2 text-body text-text-secondary"
        >
          Done
        </button>
        <button
          type="button"
          disabled={!canSend}
          onPointerDown={e => {
            e.preventDefault();
          }}
          onClick={onSend}
          className="mobile-tap brand-bar rounded-lg px-4 text-body font-medium text-white disabled:opacity-45"
        >
          {sendLabel}
        </button>
      </header>
      <textarea
        ref={boxRef}
        value={value}
        onChange={e => {
          onChange(e.target.value);
        }}
        aria-label="Message"
        placeholder="Message the agent…"
        className="min-h-0 flex-1 resize-none bg-transparent px-4 py-3 mobile-input leading-[1.5] text-text-primary outline-none placeholder:text-text-tertiary"
      />
    </div>
  );
}
