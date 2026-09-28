import type { ComponentType, ReactElement } from 'react';
import {
  AtSign,
  Camera,
  Cpu,
  History,
  Images,
  KeyboardOff,
  Maximize2,
  Slash,
  Square,
} from 'lucide-react';
import { tick } from '../lib/haptics';

export type KeyAction =
  | 'hide-keyboard'
  | 'commands'
  | 'files'
  | 'library'
  | 'camera'
  | 'interrupt'
  | 'model'
  | 'recall'
  | 'editor';

interface Key {
  action: KeyAction;
  label: string;
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
}

const KEYS: readonly Key[] = [
  { action: 'hide-keyboard', label: 'Hide keyboard', icon: KeyboardOff },
  { action: 'commands', label: 'Commands', icon: Slash },
  { action: 'files', label: 'Mention a file', icon: AtSign },
  { action: 'library', label: 'Attach from library', icon: Images },
  { action: 'camera', label: 'Take a photo', icon: Camera },
  { action: 'interrupt', label: 'Interrupt the agent', icon: Square },
  { action: 'model', label: 'Model', icon: Cpu },
  { action: 'recall', label: 'Recall last sent message', icon: History },
  { action: 'editor', label: 'Full-screen editor', icon: Maximize2 },
];

interface KeyRowProps {
  onKey: (action: KeyAction) => void;
  /** Keys that do nothing right now, drawn dimmed. */
  disabled: ReadonlySet<KeyAction>;
}

/**
 * The row of keys that rides on top of the on-screen keyboard. A key never
 * takes focus from the message box — pressing one would otherwise drop the
 * keyboard it sits on — except the one whose job is to drop it.
 */
export function KeyRow({ onKey, disabled }: KeyRowProps): ReactElement {
  return (
    <div
      role="toolbar"
      aria-label="Composer keys"
      className="mobile-keyrow flex shrink-0 gap-1 overflow-x-auto overscroll-x-contain px-1"
    >
      {KEYS.map(({ action, label, icon: Icon }) => (
        <button
          key={action}
          type="button"
          aria-label={label}
          title={label}
          disabled={disabled.has(action)}
          onPointerDown={e => {
            if (action !== 'hide-keyboard') e.preventDefault();
          }}
          onClick={() => {
            tick();
            onKey(action);
          }}
          className={`mobile-tap flex shrink-0 items-center justify-center rounded-lg text-text-secondary active:bg-[color:var(--surface-hover)] disabled:opacity-35 ${
            action === 'interrupt' ? 'text-error' : ''
          }`}
        >
          <Icon aria-hidden className="h-5 w-5" />
        </button>
      ))}
    </div>
  );
}
