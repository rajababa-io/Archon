import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react';
import { useNavigate } from 'react-router';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';
import * as skill from '../skills';
import type { Project } from '../primitives/project';
import { conversationLabel } from '../primitives/conversation';
import { formatProjectLocator } from '../lib/format';
import { paletteResultKey, paletteResults, type PaletteResult } from '../lib/palette-results';
import type { OpenChatRequest } from '../lib/open-chat';

interface ProjectPaletteProps {
  open: boolean;
  onClose: () => void;
}

/**
 * The ⌘K overlay: jump to a project, or open any chat by its title, across
 * every project. Opened by ⌘K / Ctrl+K anywhere, or `p` outside a text field.
 *
 * Chats are open and done alike; a done chat is tagged "closed", the word the
 * rail uses for that scope. They come from one list read while the palette is
 * open and are filtered here, so typing never calls the server. How the two
 * kinds rank against each other is `paletteResults`.
 *
 * Closes on Esc / outside-click / Enter (after navigating).
 */
export function ProjectPalette({ open, onClose }: ProjectPaletteProps): ReactElement | null {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);

  const { data: projects } = useEntity<Project[]>(K.projects, () => skill.listProjects());
  // Subscribed only while open, so each opening rereads it — see the key.
  const { data: allChats } = useEntity(open ? K.allConversations : 'noop:palette-closed', () =>
    open ? skill.listAllConversations() : Promise.resolve({ chats: [], truncated: false })
  );

  // Reset query + selection each time the palette opens. Focus is called
  // synchronously — the input ref is committed by React before useEffect
  // runs, so there's no need to defer with rAF, and deferring leaves a
  // one-frame window where Enter from the keymap can leak through to the
  // page underneath.
  useEffect(() => {
    if (open) {
      setQuery('');
      setIndex(0);
      inputRef.current?.focus();
    }
  }, [open]);

  const matches = useMemo<PaletteResult[]>(
    () => paletteResults(query, projects ?? [], allChats?.chats ?? []),
    [projects, allChats, query]
  );

  // Clamp index when the result set shrinks.
  useEffect(() => {
    if (index >= matches.length) setIndex(Math.max(0, matches.length - 1));
  }, [matches.length, index]);

  if (!open) return null;

  const choose = (picked: PaletteResult): void => {
    if (picked.kind === 'project') {
      navigate(`/console/p/${picked.project.id}`);
    } else {
      const { chat, projectId } = picked.found;
      const request: OpenChatRequest = { openChat: chat.id, done: chat.completed };
      navigate(`/console/p/${projectId}/chat`, { state: request });
    }
    onClose();
  };

  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndex(i => Math.min(matches.length - 1, i + 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex(i => Math.max(0, i - 1));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const picked = matches[index];
      if (picked !== undefined) choose(picked);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  const listboxId = 'project-palette-listbox';
  const activeOptionId =
    matches[index] !== undefined
      ? `project-palette-option-${paletteResultKey(matches[index])}`
      : undefined;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Find a chat or project"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-[12vh]"
      onClick={onClose}
    >
      <div
        onClick={e => {
          e.stopPropagation();
        }}
        className="w-full max-w-xl overflow-hidden rounded-md border border-border bg-surface-elevated shadow-2xl"
      >
        <input
          ref={inputRef}
          value={query}
          onChange={e => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={onKey}
          placeholder="Find a chat or project…"
          aria-label="Find a chat or project"
          role="combobox"
          aria-expanded="true"
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeOptionId}
          className="w-full border-b border-border bg-transparent px-3 py-1.75 text-large text-text-primary placeholder:text-text-tertiary focus:outline-none"
        />
        <ul
          id={listboxId}
          role="listbox"
          aria-label="Chats and projects"
          className="max-h-[50vh] overflow-y-auto py-1"
        >
          {matches.length === 0 ? (
            <li className="px-3 py-1.75 text-body text-text-tertiary">Nothing matches.</li>
          ) : (
            matches.map((r, i) => {
              const selected = i === index;
              const key = paletteResultKey(r);
              return (
                <li key={key} role="presentation">
                  <button
                    id={`project-palette-option-${key}`}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => {
                      choose(r);
                    }}
                    onMouseEnter={() => {
                      setIndex(i);
                    }}
                    className={`relative flex w-full items-baseline gap-2.25 px-3 py-1.25 text-left transition-colors ${
                      selected ? 'bg-surface-hover' : 'hover:bg-surface-hover'
                    }`}
                  >
                    {selected ? (
                      <span
                        aria-hidden
                        className="brand-bar pointer-events-none absolute left-0 top-1 bottom-1 w-0.5 rounded-full"
                      />
                    ) : null}
                    {r.kind === 'project' ? (
                      <ProjectRow project={r.project} />
                    ) : (
                      <ChatRow row={r} />
                    )}
                  </button>
                </li>
              );
            })
          )}
        </ul>
        <footer className="flex items-center justify-between border-t border-border px-3 py-1.25 text-mini text-text-tertiary">
          <span>↑↓ move · ↵ open · esc cancel</span>
          <span>
            {matches.length} of {(projects?.length ?? 0) + (allChats?.chats.length ?? 0)}
            {allChats?.truncated === true ? ' · oldest chats not searched' : ''}
          </span>
        </footer>
      </div>
    </div>
  );
}

const TAG = 'rounded-sm bg-surface-hover px-1 py-0.5 text-mini text-text-tertiary';

function ProjectRow({ project }: { project: Project }): ReactElement {
  return (
    <>
      <span className="text-body font-medium text-text-primary">{project.name}</span>
      {project.kind === 'folder' ? <span className={TAG}>folder</span> : null}
      <span className="truncate text-mini text-text-tertiary">{formatProjectLocator(project)}</span>
    </>
  );
}

function ChatRow({ row }: { row: Extract<PaletteResult, { kind: 'chat' }> }): ReactElement {
  const { chat } = row.found;
  return (
    <>
      <span className={TAG}>chat</span>
      <span
        className={`truncate text-body ${chat.completed ? 'text-text-tertiary' : 'text-text-primary'}`}
      >
        {conversationLabel(chat)}
      </span>
      {chat.completed ? <span className={TAG}>closed</span> : null}
      <span className="ml-auto shrink-0 truncate text-mini text-text-tertiary">
        {row.projectName ?? ''}
      </span>
    </>
  );
}
