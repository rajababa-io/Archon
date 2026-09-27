import { useMemo, useState, type KeyboardEvent } from 'react';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';
import * as skill from '../skills';
import {
  buildSlashEntries,
  enterCompletes,
  matchSlashEntries,
  providerNotice,
  type SlashMenuEntry,
} from '../lib/slash-menu';

export interface SlashMenuState {
  /** Entries to show, best first. Empty means the menu is closed. */
  matches: SlashMenuEntry[];
  /** Nothing typed after the `/` yet: show the full list under section headings. */
  grouped: boolean;
  /** Why the provider's commands are missing, when they are. */
  notice: string | null;
  active: number;
  setActive: (index: number) => void;
  complete: (entry: SlashMenuEntry) => void;
  /** Reopen after Escape, e.g. when the `/` button is clicked. */
  reopen: () => void;
  /** Keep the menu closed for this exact text, as Escape does, until it changes. */
  closeFor: (text: string) => void;
  /** Handle a composer keystroke. True when the menu consumed it. */
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
}

/**
 * State for the composer's `/` menu. The composer owns the text; this owns
 * which entry is highlighted and whether Escape closed the menu.
 *
 * Completing calls `onComplete` with the new text and nothing else — it never
 * sends. Sending stays the composer's normal Enter path.
 */
export function useSlashMenu(
  projectId: string | undefined,
  /** The chat, and the provider it runs on — whose own commands the menu adds. */
  chat: { conversationId: string; provider: string } | undefined,
  draft: string,
  onComplete: (text: string) => void
): SlashMenuState {
  // Fetched on the first `/`, not on every composer mount: most messages are
  // not commands, and the listing runs workflow discovery on the server.
  const wanted = draft.startsWith('/');
  const { data } = useEntity<skill.SlashCommandListing | null>(
    wanted
      ? K.slashCommands(
          projectId ?? 'none',
          chat?.conversationId ?? 'none',
          chat?.provider ?? 'none'
        )
      : 'noop:slash-commands',
    () =>
      wanted ? skill.listSlashCommands(projectId, chat?.conversationId) : Promise.resolve(null)
  );
  const entries = useMemo(() => (data ? buildSlashEntries(data) : []), [data]);

  // Both keyed by the draft they were set for, so a keystroke resets the
  // highlight to the best match and undoes an Escape without an effect.
  const [highlight, setHighlight] = useState({ draft, index: 0 });
  const [dismissedAt, setDismissedAt] = useState<string | null>(null);

  const all = useMemo(() => matchSlashEntries(entries, draft), [entries, draft]);
  const matches = dismissedAt === draft ? [] : all;
  const active = highlight.draft === draft ? Math.min(highlight.index, matches.length - 1) : 0;

  const setActive = (index: number): void => {
    setHighlight({ draft, index });
  };
  const complete = (entry: SlashMenuEntry): void => {
    onComplete(entry.insert);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    const entry = matches[active];
    if (entry === undefined) return false;
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setActive((active + step + matches.length) % matches.length);
        break;
      }
      case 'Tab':
        if (e.shiftKey) return false;
        complete(entry);
        break;
      case 'Enter':
        if (e.shiftKey || !enterCompletes(entry, draft)) return false;
        complete(entry);
        break;
      case 'Escape':
        setDismissedAt(draft);
        break;
      default:
        return false;
    }
    e.preventDefault();
    return true;
  };

  return {
    matches,
    grouped: draft.trim() === '/',
    notice: matches.length > 0 ? providerNotice(data ?? null) : null,
    active,
    setActive,
    complete,
    reopen: (): void => {
      setDismissedAt(null);
    },
    closeFor: setDismissedAt,
    onKeyDown,
  };
}
