import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type ReactElement,
  type Ref,
} from 'react';
import { ChevronUp } from 'lucide-react';
import type { ComposerControl } from '../../components/ChatComposer';
import { admitFiles, imagesFromClipboard, MAX_FILES } from '../../primitives/file';
import type { AskSpec } from '@archon/awaiting';
import { AT_DRAFT, stepHistory, type HistoryWalk } from '../../lib/composer-history';
import { loadDraftText, saveDraftText } from '../../lib/draft-store';
import {
  answerOwn,
  confirmChips,
  startChips,
  tapChip,
  type ChipState,
  type ChipStep,
} from '../lib/ask-chips';
import { insertWord, quoteInto, withCommand, type Edited } from '../lib/compose-text';
import { downscaleImage } from '../lib/downscale';
import { useSwipe } from '../lib/gesture';
import { AskChips } from './AskChips';
import { AttachmentTray } from './AttachmentTray';
import { FileSheet } from './FileSheet';
import { FullScreenEditor } from './FullScreenEditor';
import { KeyRow, type KeyAction } from './KeyRow';
import { ModelSheet } from './ModelSheet';
import { SendMenu, type SendMode } from './SendMenu';
import { SlashSheet } from './SlashSheet';

/** What the chat screen may do to the composer beyond the desktop's handle. */
export interface MobileComposerControl {
  /** Quote a message into the draft, below what is typed. */
  quote: (text: string) => void;
}

interface ComposerProps {
  conversationId: string;
  /** The chat's project; the `@` picker searches its files. */
  projectId: string;
  /** Which assistant answers the chat, whose own commands the `/` sheet adds. */
  provider: string;
  /** Where the draft is kept between visits — `chatDraftKey`. */
  draftKey: string;
  /** Messages you sent in this chat, oldest first — what Recall walks. */
  history: readonly string[];
  /** A turn is running: what is sent now waits behind it, unless steered. */
  working: boolean;
  /** A stop was asked for and the turn has not ended yet. */
  stopping: boolean;
  /** The running turn can take a message now (the server's answer). */
  steerable: boolean;
  /**
   * Send a message. `mode` is null for the plain Send — started now when the
   * chat is idle, queued when it works — and the Send menu's choice otherwise.
   */
  onSend: (text: string, files: File[] | undefined, mode: SendMode | null) => void;
  onInterrupt: () => void;
  /**
   * Archon cannot be reached. The draft can still be written, and is kept;
   * nothing that needs the server — sending, commands, files, the model — works.
   */
  offline: boolean;
  /** The question the chat waits on, answerable from chips; null for none. */
  ask: AskSpec | null;
  /** Queue pull-back and focus, the same handle the desktop composer offers. */
  controlRef: Ref<ComposerControl>;
  mobileRef: Ref<MobileComposerControl>;
}

/** Tallest the box grows before it scrolls, so the transcript keeps some room. */
const MAX_HEIGHT_PX = 160;

type SheetName = 'commands' | 'files' | 'model' | 'send';

/** Keys that ask the server for something, so do nothing while it is out of reach. */
const SERVER_KEYS: readonly KeyAction[] = ['commands', 'files', 'model', 'interrupt'];

/** Chip progress, and the question it belongs to, so a new question starts clean. */
interface Chips {
  /**
   * The question, by content: a refetched transcript parses it into a new
   * object, and that must not throw away the answers given so far.
   */
  key: string;
  state: ChipState;
  /** "Other…" was tapped: the next send is this question's own answer. */
  own: boolean;
}

const askKey = (ask: AskSpec | null): string => (ask === null ? '' : JSON.stringify(ask));

const chipsFor = (ask: AskSpec | null): Chips => ({
  key: askKey(ask),
  state: ask === null ? { index: 0, answers: [] } : startChips(ask),
  own: false,
});

/**
 * The message box, the key row on top of the keyboard, and everything they
 * open.
 *
 * Return inserts a newline, as in every phone messaging app; only the button
 * sends. The draft is saved per chat as it is typed (`draft-store`), so
 * leaving the chat, the app, or a reload does not lose it. Attachments live as
 * long as the screen: a File cannot be stored.
 */
export function Composer({
  conversationId,
  projectId,
  provider,
  draftKey,
  history,
  working,
  stopping,
  steerable,
  onSend,
  onInterrupt,
  offline,
  ask,
  controlRef,
  mobileRef,
}: ComposerProps): ReactElement {
  const [text, setText] = useState(() => loadDraftText(draftKey));
  const [files, setFiles] = useState<File[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(0);
  const [sheet, setSheet] = useState<SheetName | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const walkRef = useRef<HistoryWalk>(AT_DRAFT);
  const boxRef = useRef<HTMLTextAreaElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const libraryRef = useRef<HTMLInputElement | null>(null);
  const cameraRef = useRef<HTMLInputElement | null>(null);
  // Set when an edit places the caret, applied once the new value is in the DOM.
  const caretRef = useRef<number | null>(null);
  const filesRef = useRef(files);
  filesRef.current = files;

  const [chipsRaw, setChips] = useState<Chips>(() => chipsFor(ask));
  const chips = chipsRaw.key === askKey(ask) ? chipsRaw : chipsFor(ask);

  useEffect(() => {
    saveDraftText(draftKey, text);
  }, [draftKey, text]);

  // Grow with the text and land the caret, measured after each change so
  // neither is a frame behind what was typed.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (box === null) return;
    box.style.height = 'auto';
    box.style.height = `${String(Math.min(box.scrollHeight, MAX_HEIGHT_PX))}px`;
    const caret = caretRef.current;
    if (caret !== null) {
      caretRef.current = null;
      box.focus();
      box.setSelectionRange(caret, caret);
    }
  }, [text, editorOpen]);

  const apply = useCallback((edit: (current: string) => Edited): void => {
    setText(current => {
      const next = edit(current);
      caretRef.current = next.caret;
      return next.value;
    });
    walkRef.current = AT_DRAFT;
  }, []);

  useImperativeHandle(
    controlRef,
    () => ({
      restore: (restored: string): void => {
        apply(current => {
          const value = current.trim() === '' ? restored : `${current}\n${restored}`;
          return { value, caret: value.length };
        });
      },
      focus: (): void => {
        boxRef.current?.focus();
      },
    }),
    [apply]
  );
  useImperativeHandle(
    mobileRef,
    () => ({
      quote: (quoted: string): void => {
        apply(current => quoteInto(current, quoted));
      },
    }),
    [apply]
  );

  useSwipe(formRef, (swipe, start) => {
    // Inside a box long enough to scroll, an upward drag is the scroll.
    const box = boxRef.current;
    if (start.target === box && box !== null && box.scrollHeight > box.clientHeight) return;
    if (swipe === 'up') setEditorOpen(true);
  });

  /** Shrink pictures on the phone, then attach whatever the limits admit. */
  const attach = (incoming: File[]): void => {
    if (incoming.length === 0) return;
    setPreparing(n => n + incoming.length);
    void Promise.all(incoming.map(downscaleImage)).then(prepared => {
      setPreparing(n => n - incoming.length);
      const admitted = admitFiles(filesRef.current, prepared);
      setFiles(admitted.files);
      setFileError(admitted.error);
    });
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    const images = imagesFromClipboard(e.clipboardData.items);
    if (images.length === 0) return;
    attach(images);
    // An image with its own text on the clipboard pastes both: see the
    // desktop composer, whose rule this is.
    if (e.clipboardData.getData('text/plain').length === 0) e.preventDefault();
  };

  const clearAfterSend = (): void => {
    setText('');
    setFiles([]);
    setFileError(null);
    walkRef.current = AT_DRAFT;
  };

  const attached = (): File[] | undefined => (files.length > 0 ? [...files] : undefined);

  const chipStep = (step: ChipStep): void => {
    if (step.kind === 'send') {
      onSend(step.text, attached(), null);
      setFiles([]);
      setFileError(null);
      setChips(chipsFor(ask));
      return;
    }
    setChips({ key: chips.key, state: step.state, own: false });
  };

  const canSend = !offline && text.trim() !== '' && preparing === 0;
  const send = (mode: SendMode | null): void => {
    const trimmed = text.trim();
    if (!canSend) return;
    setSheet(null);
    setEditorOpen(false);
    if (chips.own && ask !== null) {
      setText('');
      chipStep(answerOwn(ask, chips.state, trimmed));
      return;
    }
    onSend(trimmed, attached(), mode);
    clearAfterSend();
  };

  const selection = (): { start: number; end: number } => {
    const box = boxRef.current;
    return box === null
      ? { start: text.length, end: text.length }
      : { start: box.selectionStart, end: box.selectionEnd };
  };

  const onKey = (action: KeyAction): void => {
    switch (action) {
      case 'hide-keyboard':
        boxRef.current?.blur();
        break;
      case 'commands':
      case 'files':
      case 'model':
        setSheet(action);
        break;
      case 'library':
        libraryRef.current?.click();
        break;
      case 'camera':
        cameraRef.current?.click();
        break;
      case 'interrupt':
        onInterrupt();
        break;
      case 'recall': {
        const step = stepHistory(history, walkRef.current, 'older', text);
        if (step === null) break;
        setText(step.text);
        caretRef.current = step.text.length;
        walkRef.current = step.walk;
        break;
      }
      case 'editor':
        setEditorOpen(true);
        break;
    }
  };

  const disabledKeys = new Set<KeyAction>();
  if (!working || stopping) disabledKeys.add('interrupt');
  if (files.length + preparing >= MAX_FILES) {
    disabledKeys.add('library');
    disabledKeys.add('camera');
  }
  if (history.length === 0) disabledKeys.add('recall');
  if (offline) for (const key of SERVER_KEYS) disabledKeys.add(key);

  const steerBlocked = !steerable
    ? 'This turn cannot take a message until it ends.'
    : files.length > 0
      ? 'A message with attachments waits for its own turn.'
      : null;
  const sendLabel = working ? 'Queue' : 'Send';
  const question = ask?.questions[chips.state.index];
  const placeholder =
    chips.own && question !== undefined
      ? `Your answer: ${question.title}`
      : offline
        ? 'Offline — write now, send later'
        : working
          ? 'Agent is working — Queue sends it after…'
          : 'Message the agent…';

  const pickFile = (input: HTMLInputElement | null): void => {
    if (input?.files != null) attach(Array.from(input.files));
    if (input !== null) input.value = '';
  };

  return (
    <>
      <div className="mobile-composer flex shrink-0 flex-col border-t border-border bg-surface">
        <AttachmentTray
          files={files}
          error={fileError}
          preparing={preparing}
          onRemove={index => {
            setFiles(prev => prev.filter((_, i) => i !== index));
            setFileError(null);
          }}
        />
        {ask !== null ? (
          <AskChips
            spec={ask}
            state={chips.state}
            answeringOwn={chips.own}
            onTap={label => {
              chipStep(tapChip(ask, chips.state, label));
            }}
            onConfirm={() => {
              chipStep(confirmChips(ask, chips.state));
            }}
            onOther={() => {
              setChips({ ...chips, own: !chips.own });
              boxRef.current?.focus();
            }}
          />
        ) : null}
        <form
          ref={formRef}
          className="flex items-end gap-2 px-3 pt-2"
          onSubmit={e => {
            e.preventDefault();
            send(null);
          }}
        >
          <textarea
            ref={boxRef}
            value={text}
            onChange={e => {
              walkRef.current = AT_DRAFT;
              setText(e.target.value);
            }}
            onPaste={onPaste}
            rows={1}
            placeholder={placeholder}
            aria-label="Message"
            className="min-h-11 min-w-0 flex-1 resize-none rounded-lg border border-border bg-surface-inset px-3 py-2.5 text-[16px] leading-[1.4] text-text-primary outline-none placeholder:text-text-tertiary focus:border-border-bright"
          />
          <div className="flex shrink-0">
            <button
              type="submit"
              disabled={!canSend}
              onPointerDown={e => {
                e.preventDefault();
              }}
              className={`mobile-tap brand-bar px-4 text-body font-medium text-white disabled:opacity-45 ${
                working ? 'rounded-l-lg' : 'rounded-lg'
              }`}
            >
              {sendLabel}
            </button>
            {working ? (
              <button
                type="button"
                aria-label="More send options"
                disabled={!canSend}
                onClick={() => {
                  setSheet('send');
                }}
                className="mobile-tap brand-bar flex items-center justify-center rounded-r-lg border-l border-white/25 text-white disabled:opacity-45"
              >
                <ChevronUp aria-hidden className="h-4 w-4" />
              </button>
            ) : null}
          </div>
        </form>
        <KeyRow onKey={onKey} disabled={disabledKeys} />
        <input
          ref={libraryRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          aria-label="Photos to attach"
          onChange={e => {
            pickFile(e.currentTarget);
          }}
        />
        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          aria-label="Photo to take"
          onChange={e => {
            pickFile(e.currentTarget);
          }}
        />
      </div>
      {editorOpen ? (
        <FullScreenEditor
          value={text}
          onChange={value => {
            walkRef.current = AT_DRAFT;
            setText(value);
          }}
          onClose={() => {
            setEditorOpen(false);
          }}
          onSend={() => {
            send(null);
          }}
          sendLabel={sendLabel}
          canSend={canSend}
        />
      ) : null}
      <SlashSheet
        open={sheet === 'commands'}
        onClose={() => {
          setSheet(null);
        }}
        projectId={projectId}
        chat={{ conversationId, provider }}
        onPick={insert => {
          setSheet(null);
          apply(current => withCommand(current, insert));
        }}
      />
      <FileSheet
        open={sheet === 'files'}
        onClose={() => {
          setSheet(null);
        }}
        projectId={projectId}
        onPick={path => {
          const { start, end } = selection();
          setSheet(null);
          apply(current => insertWord(current, start, end, `@${path}`));
        }}
      />
      <ModelSheet
        open={sheet === 'model'}
        onClose={() => {
          setSheet(null);
        }}
        conversationId={conversationId}
      />
      <SendMenu
        open={sheet === 'send'}
        onClose={() => {
          setSheet(null);
        }}
        steerBlocked={steerBlocked}
        onPick={mode => {
          send(mode);
        }}
      />
    </>
  );
}
