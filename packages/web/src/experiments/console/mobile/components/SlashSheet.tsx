import { Fragment, useMemo, useState, type ReactElement } from 'react';
import * as skill from '../../skills';
import { useEntity } from '../../store/cache';
import { K } from '../../store/keys';
import {
  buildSlashEntries,
  matchSlashEntries,
  providerNotice,
  type SlashMenuEntry,
} from '../../lib/slash-menu';
import { Sheet, SheetRow } from './Sheet';

interface SlashSheetProps {
  open: boolean;
  onClose: () => void;
  projectId: string | undefined;
  /** The chat and its provider, whose own commands the list adds. */
  chat: { conversationId: string; provider: string };
  /** Put the chosen command in the composer. Nothing is sent. */
  onPick: (insert: string) => void;
}

/**
 * The desktop `/` menu as a sheet: the same server listing, ranked by the
 * same rules, searched from a box of its own because a phone has no arrow
 * keys to walk a menu that hangs off the composer.
 */
export function SlashSheet({
  open,
  onClose,
  projectId,
  chat,
  onPick,
}: SlashSheetProps): ReactElement {
  return (
    <Sheet title="Commands" open={open} onClose={onClose} tall>
      {open ? <SlashList projectId={projectId} chat={chat} onPick={onPick} /> : null}
    </Sheet>
  );
}

function SlashList({
  projectId,
  chat,
  onPick,
}: Omit<SlashSheetProps, 'open' | 'onClose'>): ReactElement {
  const { data, error } = useEntity<skill.SlashCommandListing>(
    K.slashCommands(projectId ?? 'none', chat.conversationId, chat.provider),
    () => skill.listSlashCommands(projectId, chat.conversationId)
  );
  const [query, setQuery] = useState('');
  const entries = useMemo(() => (data === undefined ? [] : buildSlashEntries(data)), [data]);
  const matches = useMemo(() => matchSlashEntries(entries, `/${query}`), [entries, query]);
  const grouped = query.trim() === '';
  const notice = providerNotice(data ?? null);

  return (
    <>
      <div className="shrink-0 px-4 pb-2">
        <input
          type="search"
          value={query}
          onChange={e => {
            setQuery(e.target.value.replace(/^\//, ''));
          }}
          placeholder="Search commands and workflows"
          aria-label="Search commands"
          autoComplete="off"
          className="min-h-11 w-full rounded-lg border border-border bg-surface-inset px-3 text-[16px] text-text-primary outline-none placeholder:text-text-tertiary"
        />
      </div>
      {notice !== null ? <p className="mobile-note">{notice}</p> : null}
      {error !== undefined ? (
        <p role="alert" className="mobile-note text-error">
          Could not load commands: {error.message}
        </p>
      ) : data === undefined ? (
        <p className="mobile-note">Loading…</p>
      ) : matches.length === 0 ? (
        <p className="mobile-note">No command matches.</p>
      ) : (
        <ul aria-label="Commands">
          {matches.map((entry, i) => (
            <Fragment key={entry.id}>
              {grouped && entry.group !== matches[i - 1]?.group ? (
                <li className="px-4 pt-3 pb-1 font-mono text-[10px] tracking-[0.06em] text-text-tertiary uppercase">
                  {entry.group}
                </li>
              ) : null}
              <li>
                <SheetRow
                  onPick={() => {
                    onPick(entry.insert);
                  }}
                >
                  <CommandLabel entry={entry} />
                </SheetRow>
              </li>
            </Fragment>
          ))}
        </ul>
      )}
    </>
  );
}

function CommandLabel({ entry }: { entry: SlashMenuEntry }): ReactElement {
  return (
    <span className="flex flex-col">
      <span className="truncate font-mono">
        {entry.label}
        {entry.args !== '' ? <span className="text-text-tertiary"> {entry.args}</span> : null}
      </span>
      {entry.description !== '' ? (
        <span className="truncate text-small text-text-tertiary">{entry.description}</span>
      ) : null}
    </span>
  );
}
