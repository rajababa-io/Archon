import { useEffect, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { Check, Globe, Link as LinkIcon, Lock, X } from 'lucide-react';
import { getShare, setShare, type Share, type ShareAccess } from '../skills/shares';

interface ShareDialogProps {
  /** The published file's private address, `/files/…`. */
  path: string;
  onClose: () => void;
}

const ACCESS_OPTIONS: { value: ShareAccess; label: string; hint: string }[] = [
  {
    value: 'restricted',
    label: 'Restricted',
    hint: 'Only people who can sign in to this console can open it.',
  },
  {
    value: 'link',
    label: 'Anyone with the link',
    hint: 'Anyone can open this link, without signing in.',
  },
];

/**
 * Share one published page or file, the way a claude.ai artifact is shared
 * (#345): a general-access choice and a link to copy.
 *
 * The share is read on open rather than cached: an agent's `share_page` tool
 * changes the same row, and a stale "Restricted" here would hide that a page
 * is public.
 */
export function ShareDialog({ path, onClose }: ShareDialogProps): ReactElement {
  const [share, setShareState] = useState<Share | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    let live = true;
    getShare(path).then(
      s => {
        if (!live) return;
        setShareState(s);
        setLoading(false);
      },
      (e: unknown) => {
        if (!live) return;
        setError(e instanceof Error ? e.message : 'Could not read this share.');
        setLoading(false);
      }
    );
    return (): void => {
      live = false;
    };
  }, [path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return (): void => {
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const access: ShareAccess = share?.access ?? 'restricted';
  const isPublic = access === 'link' && share !== null;
  const link = isPublic ? `${window.location.origin}${share.address}` : null;

  const change = async (next: ShareAccess): Promise<void> => {
    // Never shared and staying restricted: nothing to write.
    if (next === access) return;
    setBusy(true);
    setError(null);
    try {
      setShareState(await setShare(path, next));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not change who can open this.');
    } finally {
      setBusy(false);
    }
  };

  const copy = (): void => {
    if (link === null) return;
    const settle = (next: 'copied' | 'failed'): void => {
      setCopied(next);
      setTimeout(() => {
        setCopied('idle');
      }, 1500);
    };
    // writeText inside .then routes both the async rejection and the
    // synchronous TypeError (no clipboard in an insecure context) to one place.
    void Promise.resolve()
      .then(() => navigator.clipboard.writeText(link))
      .then(
        () => {
          settle('copied');
        },
        () => {
          settle('failed');
        }
      );
  };

  // A web page is shared with its folder (see the server's `shareTarget`), so
  // an index page is named by that folder, and the dialog says so.
  const segments = decodeURIComponent(path.replace(/\/+$/, '')).split('/');
  const isPage = /\.html?$/i.test(path);
  const last = segments.at(-1) ?? path;
  const name = last === 'index.html' && segments.length > 1 ? (segments.at(-2) ?? last) : last;
  const hint = ACCESS_OPTIONS.find(o => o.value === access)?.hint ?? '';

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Share ${name}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-[6px]"
      onMouseDown={onClose}
    >
      <div
        onMouseDown={e => {
          e.stopPropagation();
        }}
        className="relative w-full max-w-[460px] overflow-hidden rounded-lg border border-border-bright bg-surface-elevated p-[22px] text-text-primary shadow-[0_30px_80px_-24px_rgba(0,0,0,0.8)]"
      >
        <span aria-hidden className="brand-bar absolute left-0 right-0 top-0 h-[2px] opacity-90" />
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-large font-medium">Share {name}</h2>
            <p className="mt-0.5 truncate font-mono text-mini text-text-tertiary">{path}</p>
            {isPage ? (
              <p className="mt-1 text-mini text-text-tertiary">
                A page is shared with the folder it sits in, so its pictures and scripts load.
              </p>
            ) : null}
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="rounded p-1 text-text-tertiary hover:bg-surface-inset hover:text-text-primary"
          >
            <X size={16} />
          </button>
        </div>

        <p className="mb-1.5 text-small text-text-secondary">General access</p>
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-inset text-text-secondary"
          >
            {isPublic ? <Globe size={16} /> : <Lock size={16} />}
          </span>
          <div className="min-w-0 flex-1">
            <select
              aria-label="Who can open this"
              value={access}
              disabled={loading || busy}
              onChange={e => {
                void change(e.target.value as ShareAccess);
              }}
              className="rounded-[8px] border border-border bg-surface-inset px-2.5 py-1 text-small text-text-primary transition-colors hover:border-border-bright disabled:opacity-60"
            >
              {ACCESS_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-mini text-text-tertiary">{loading ? 'Checking…' : hint}</p>
          </div>
        </div>

        {error !== null ? <p className="mt-3 text-mini text-error">{error}</p> : null}

        <div className="mt-5 flex items-center justify-between gap-3 border-t border-border pt-4">
          <p className="min-w-0 truncate font-mono text-mini text-text-tertiary">
            {link ?? 'Choose “Anyone with the link” to get a link'}
          </p>
          <button
            type="button"
            onClick={copy}
            disabled={link === null}
            className="flex shrink-0 items-center gap-1.5 rounded-[8px] border border-border-bright bg-surface-inset px-3 py-1.5 text-small text-text-primary transition-colors hover:border-accent-bright disabled:opacity-50"
          >
            {copied === 'copied' ? <Check size={14} /> : <LinkIcon size={14} />}
            {copied === 'copied' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy link'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

/**
 * The small Share control beside a link to a published file. Its own state,
 * so a message full of links does not re-render when one dialog opens.
 */
export function ShareLinkButton({ path }: { path: string }): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-label="Share"
        title="Share"
        onClick={e => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
        }}
        className="ml-1 inline-flex translate-y-[2px] items-center rounded p-0.5 align-baseline text-text-tertiary transition-colors hover:bg-surface-inset hover:text-accent-bright"
      >
        <Globe size={13} />
      </button>
      {open ? (
        <ShareDialog
          path={path}
          onClose={() => {
            setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}
