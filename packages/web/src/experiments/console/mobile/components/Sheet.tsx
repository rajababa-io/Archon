import { useEffect, type ReactElement, type ReactNode } from 'react';

interface SheetProps {
  /** Names the dialog, and heads it. */
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Fill the screen's height — a list to search — rather than fit what is in it. */
  tall?: boolean;
}

/**
 * A panel that rises from the bottom of the screen over the chat, the phone's
 * menu: tap outside it, Close, or Escape puts it away.
 */
export function Sheet({
  title,
  open,
  onClose,
  children,
  tall = false,
}: SheetProps): ReactElement | null {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return (): void => {
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="absolute inset-0 z-40 flex flex-col">
      <button
        type="button"
        aria-label={`Close ${title}`}
        tabIndex={-1}
        onClick={onClose}
        className="min-h-12 flex-1 bg-black/50"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`mobile-sheet flex flex-col rounded-t-2xl border-t border-border bg-surface shadow-xl ${
          tall ? 'h-[85%]' : 'max-h-[85%]'
        }`}
      >
        <header className="flex shrink-0 items-center justify-between px-4 pt-1">
          <span className="text-large font-medium text-text-primary">{title}</span>
          <button
            type="button"
            onClick={onClose}
            className="mobile-tap text-body text-text-secondary"
          >
            Close
          </button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain pb-3">
          {children}
        </div>
      </div>
    </div>
  );
}

/** One full-width choice in a sheet. */
export function SheetRow({
  onPick,
  children,
  checked,
  disabled = false,
}: {
  onPick: () => void;
  children: ReactNode;
  /** A choice that is on right now: marked, and announced as such. */
  checked?: boolean;
  disabled?: boolean;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={disabled}
      aria-pressed={checked}
      className="mobile-row flex w-full items-center gap-3 px-4 text-left text-body text-text-primary active:bg-[color:var(--surface-hover)] disabled:opacity-45"
    >
      <span className="min-w-0 flex-1">{children}</span>
      {checked === true ? (
        <span aria-hidden className="text-accent-bright">
          ✓
        </span>
      ) : null}
    </button>
  );
}
