import type { ReactElement } from 'react';
import { Sheet, SheetRow } from './Sheet';

/** What Send does with a message while a turn is running. */
export type SendMode = 'queue' | 'steer' | 'interrupt';

interface SendMenuProps {
  open: boolean;
  onClose: () => void;
  onPick: (mode: SendMode) => void;
  /**
   * Why Steer now is not on offer, or null when it is: the running turn
   * cannot take input, or the message carries files.
   */
  steerBlocked: string | null;
}

/** The choices beside Send while the agent works. */
export function SendMenu({ open, onClose, onPick, steerBlocked }: SendMenuProps): ReactElement {
  const row = (mode: SendMode, label: string, detail: string, disabled = false): ReactElement => (
    <SheetRow
      disabled={disabled}
      onPick={() => {
        onPick(mode);
      }}
    >
      <span className="flex flex-col">
        <span>{label}</span>
        <span className="text-small text-text-tertiary">{detail}</span>
      </span>
    </SheetRow>
  );
  return (
    <Sheet title="Send options" open={open} onClose={onClose}>
      {row('queue', 'Queue', 'Sent when the agent finishes this turn.')}
      {row(
        'steer',
        'Steer now',
        steerBlocked ?? 'Handed to the agent inside the turn it is running.',
        steerBlocked !== null
      )}
      {row('interrupt', 'Interrupt & send', 'Stops the turn; this message goes next.')}
    </Sheet>
  );
}
