import { useState, type ReactElement } from 'react';
import { writeClipboardText } from '../../lib/clipboard';
import { Sheet, SheetRow } from './Sheet';

interface MessageActionsProps {
  /** The long-pressed message's text; null when none is. */
  text: string | null;
  onClose: () => void;
  onQuote: (text: string) => void;
}

/** What a long-press on a message offers: copy it, share it, or quote it. */
export function MessageActions({ text, onClose, onQuote }: MessageActionsProps): ReactElement {
  const [notice, setNotice] = useState<string | null>(null);
  const close = (): void => {
    setNotice(null);
    onClose();
  };
  const canShare = typeof navigator.share === 'function';

  return (
    <Sheet title="Message" open={text !== null} onClose={close}>
      <SheetRow
        onPick={() => {
          if (text === null) return;
          void writeClipboardText(text).then(copied => {
            if (copied) close();
            else setNotice('Copying is not allowed here — select the text instead.');
          });
        }}
      >
        Copy
      </SheetRow>
      {canShare ? (
        <SheetRow
          onPick={() => {
            if (text === null) return;
            navigator.share({ text }).then(close, (e: unknown) => {
              // Closing the share sheet without choosing is not a failure.
              if (e instanceof DOMException && e.name === 'AbortError') return;
              setNotice(`Could not share: ${e instanceof Error ? e.message : 'unknown error'}`);
            });
          }}
        >
          Share
        </SheetRow>
      ) : null}
      <SheetRow
        onPick={() => {
          if (text === null) return;
          onQuote(text);
          close();
        }}
      >
        Quote in reply
      </SheetRow>
      {notice !== null ? (
        <p role="alert" className="mobile-note text-error">
          {notice}
        </p>
      ) : null}
    </Sheet>
  );
}
