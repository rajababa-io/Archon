/**
 * A project's deploy controls, in a thin row under its name (#211, #226).
 *
 * Rendered for a project the server says has a deploy; a project without one
 * draws DeploySetupRow in the same place and at the same height. The row is
 * permanent: Live is always in the same place, whether a deploy is running or
 * not. The Archon host deploy and a workflow deploy draw the same row; only
 * the words for a running deploy, and the Deploy now confirm, differ.
 *
 * Every action goes to the server and the row then re-reads it; nothing here
 * decides what the deploy state is. The one local state that runs ahead of
 * the server is the switch, which flips on click and flips back if the PATCH
 * is refused, because a switch that lags a round trip reads as unpressed.
 *
 * The waiting list portals out of the row: the row scrolls sideways on a
 * phone, and an overflow container clips anything positioned inside it.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import * as skill from '../skills';
import type { ProjectDeploy } from '../skills/deploy';
import { HttpError, errorDetail } from '../lib/http';
import { useLiveChats } from '../lib/live-chats';
import { useProjectDeployRefresh } from '../hooks/useProjectDeployRefresh';
import { useNow } from '../lib/clock';
import { shortSha } from '../lib/deploy-strip';
import {
  PERSON_ONLY_TITLE,
  deployConfirm,
  deployRowView,
  liveMissingLabel,
  turnedOnNotice,
  waitingFooter,
  type DeployConfirm,
} from '../lib/deploy-row';
import { patch } from '../store/cache';
import { K } from '../store/keys';

const ERROR_MS = 8_000;
const POPOVER_WIDTH = 430;
const MARGIN = 8;

const BUTTON =
  'shrink-0 rounded-md px-2.75 py-0.75 text-small font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50';
// Outlines are rings, not borders: the console scope repaints every border
// colour (see theme.css), and a ring is a box-shadow it does not touch.
export const PRIMARY = `${BUTTON} bg-accent/15 text-text-primary ring-1 ring-inset ring-accent hover:bg-accent/25`;
const STOP = `${BUTTON} bg-transparent text-error ring-1 ring-inset ring-error/45 hover:bg-error/10 hover:ring-error`;
export const GHOST = `${BUTTON} bg-transparent font-medium text-text-secondary ring-1 ring-inset ring-border-bright hover:text-text-primary`;

function actionError(err: unknown): string {
  return err instanceof HttpError && err.serverError !== undefined
    ? err.serverError
    : errorDetail(err);
}

function Sep(): ReactElement {
  return <span aria-hidden className="h-4 w-px shrink-0 bg-border" />;
}

interface DeployRowProps {
  projectId: string;
  projectName: string;
  deploy: ProjectDeploy;
}

export function DeployRow({ projectId, projectName, deploy }: DeployRowProps): ReactElement {
  const key = K.projectDeploy(projectId);
  const { drain } = useLiveChats();
  const counting =
    deploy.method === 'archon-host' &&
    deploy.status.phase === 'draining' &&
    drain?.parkAt !== undefined;
  // One second while the park countdown runs; otherwise only "deployed 2h ago" moves.
  const now = useNow(counting ? 1_000 : 30_000);
  const view = deployRowView(deploy, drain, now);

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [confirm, setConfirm] = useState<DeployConfirm | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pillRef = useRef<HTMLButtonElement | null>(null);

  const reload = useProjectDeployRefresh(projectId);

  useEffect(() => {
    if (error === null) return;
    const id = setTimeout(() => {
      setError(null);
    }, ERROR_MS);
    return (): void => {
      clearTimeout(id);
    };
  }, [error]);

  const run = async (action: () => Promise<void>): Promise<boolean> => {
    setError(null);
    setBusy(true);
    try {
      await action();
      return true;
    } catch (err) {
      setError(actionError(err));
      return false;
    } finally {
      setBusy(false);
      reload();
    }
  };

  const toggle = (on: boolean): void => {
    const before = deploy.deployOnMerge;
    patch(key, prev =>
      prev === null || prev === undefined ? prev : { ...prev, deployOnMerge: on }
    );
    setNotice(on ? turnedOnNotice(deploy.waiting) : null);
    void run(async () => {
      try {
        await skill.setDeployOnMerge(projectId, on);
      } catch (err) {
        patch(key, prev =>
          prev === null || prev === undefined ? prev : { ...prev, deployOnMerge: before }
        );
        setNotice(null);
        throw err;
      }
    });
  };

  const ship = (): void => {
    const tip = deploy.waiting?.tipSha;
    setConfirm(null);
    setPopoverOpen(false);
    if (tip === undefined) return;
    void run(() => skill.deployNow(projectId, tip)).then(ok => {
      if (ok) setNotice(null);
    });
  };

  const startDeploy = (): void => {
    setPopoverOpen(false);
    // Only the host deploy pauses running work, which is all the confirm is about.
    const ask = deploy.method === 'archon-host' ? deployConfirm(projectName, deploy.running) : null;
    if (ask === null) ship();
    else setConfirm(ask);
  };

  const cancel = (): void => {
    void run(() => skill.cancelProjectDeploy(projectId));
  };

  const actTitle = deploy.canAct ? undefined : PERSON_ONLY_TITLE;
  const disabled = busy || !deploy.canAct;

  return (
    <>
      <div
        data-testid="deploy-row"
        className="-mx-4.75 flex h-9 shrink-0 items-center gap-4 overflow-x-auto whitespace-nowrap border-y bg-surface-inset px-4.75 text-body max-md:gap-2.5"
      >
        <span className="inline-flex shrink-0 items-center gap-1.75">
          <span aria-hidden className="size-2 rounded-full bg-success" />
          <span className="text-text-primary">Live</span>
          <span className="font-mono text-small text-text-tertiary">
            {view.live.sha ?? liveMissingLabel(deploy)}
            {view.live.ago !== null ? ` · ${view.live.ago}` : ''}
          </span>
        </span>
        <Sep />

        {view.kind === 'deploying' ? (
          <>
            <span className="inline-flex shrink-0 items-center gap-2.25 text-text-secondary">
              <span aria-hidden className="size-2 rounded-full bg-[color:var(--running)]" />
              {view.progress}
              <span
                aria-hidden
                className="h-1 w-[90px] overflow-hidden rounded-full bg-surface-hover"
              >
                <i
                  className={`block h-full bg-[color:var(--running)]${
                    view.fraction === null ? ' w-full animate-pulse' : ''
                  }`}
                  style={
                    view.fraction === null
                      ? undefined
                      : { width: `${String(view.fraction * 100)}%` }
                  }
                />
              </span>
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-2.5">
              {error !== null ? <span className="text-small text-error">{error}</span> : null}
              {view.showCancel ? (
                <button
                  type="button"
                  className={STOP}
                  disabled={disabled}
                  title={actTitle}
                  onClick={cancel}
                >
                  Cancel deploy
                </button>
              ) : null}
            </span>
          </>
        ) : (
          <>
            <button
              type="button"
              role="switch"
              aria-checked={view.deployOnMerge}
              disabled={disabled}
              title={actTitle}
              onClick={() => {
                toggle(!view.deployOnMerge);
              }}
              className="inline-flex shrink-0 items-center gap-2 text-text-primary disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span
                aria-hidden
                className="relative h-[18px] w-[30px] rounded-full transition-colors"
                style={{
                  background: view.deployOnMerge ? 'var(--success)' : 'var(--surface-bright)',
                }}
              >
                <span
                  className="absolute top-[3px] size-3 rounded-full transition-all"
                  style={{
                    left: view.deployOnMerge ? '15px' : '3px',
                    background: view.deployOnMerge ? 'oklch(0.99 0 0)' : 'var(--text-secondary)',
                  }}
                />
              </span>
              Deploy on Merge
            </button>

            {view.right.kind === 'waiting' ? (
              <>
                <Sep />
                <button
                  ref={pillRef}
                  type="button"
                  aria-expanded={popoverOpen}
                  aria-haspopup="dialog"
                  onClick={() => {
                    setPopoverOpen(open => !open);
                  }}
                  className="shrink-0 rounded-full bg-warning/15 px-2.25 py-0.5 text-small text-warning ring-1 ring-inset ring-warning/35 hover:bg-warning/20"
                >
                  {view.right.label} ▾
                </button>
              </>
            ) : null}

            <span className="ml-auto flex shrink-0 items-center gap-2.5">
              {error !== null ? <span className="text-small text-error">{error}</span> : null}
              {view.blocked !== null ? (
                <button type="button" className={PRIMARY} disabled title={view.blocked}>
                  Deploy now
                </button>
              ) : view.right.kind === 'waiting' ? (
                <button
                  type="button"
                  className={PRIMARY}
                  disabled={disabled}
                  title={actTitle}
                  onClick={startDeploy}
                >
                  Deploy now
                </button>
              ) : null}
              {view.right.kind === 'up-to-date' ? (
                <span className="font-mono text-small text-text-tertiary">Up to date</span>
              ) : null}
              {view.right.kind === 'unknown' ? (
                <span className="text-small text-text-tertiary" title={view.right.reason}>
                  {view.right.label}
                </span>
              ) : null}
            </span>
          </>
        )}
      </div>

      {notice !== null && view.kind === 'idle' && view.deployOnMerge ? (
        <p className="text-small text-text-secondary">
          {notice}{' '}
          <button
            type="button"
            className="font-medium text-text-primary underline underline-offset-2 hover:text-accent-bright disabled:cursor-not-allowed disabled:opacity-50"
            disabled={disabled || deploy.waiting === null || view.blocked !== null}
            title={view.blocked ?? actTitle}
            onClick={startDeploy}
          >
            Deploy now?
          </button>
        </p>
      ) : null}

      {popoverOpen && view.kind === 'idle' && deploy.waiting !== null ? (
        <WaitingPopover
          anchor={pillRef.current}
          liveSha={deploy.live.sha}
          waiting={deploy.waiting}
          disabled={disabled || view.blocked !== null}
          actTitle={view.blocked ?? actTitle}
          onDeploy={startDeploy}
          onClose={() => {
            setPopoverOpen(false);
          }}
        />
      ) : null}

      {confirm !== null ? (
        <ConfirmDeploy
          confirm={confirm}
          onCancel={() => {
            setConfirm(null);
          }}
          onDeploy={ship}
        />
      ) : null}
    </>
  );
}

interface WaitingPopoverProps {
  anchor: HTMLElement | null;
  liveSha: string | null;
  waiting: NonNullable<ProjectDeploy['waiting']>;
  disabled: boolean;
  actTitle: string | undefined;
  onDeploy: () => void;
  onClose: () => void;
}

function WaitingPopover({
  anchor,
  liveSha,
  waiting,
  disabled,
  actTitle,
  onDeploy,
  onClose,
}: WaitingPopoverProps): ReactElement {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const place = (): void => {
      if (anchor === null) return;
      const rect = anchor.getBoundingClientRect();
      const width = Math.min(POPOVER_WIDTH, window.innerWidth - 2 * MARGIN);
      setAt({
        top: rect.bottom + 6,
        left: Math.min(Math.max(MARGIN, rect.left), window.innerWidth - MARGIN - width),
      });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return (): void => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [anchor]);

  useEffect(() => {
    const onPointer = (e: MouseEvent): void => {
      const t = e.target as Node | null;
      if (t === null) return;
      // The pill toggles the list itself; closing here too would reopen it.
      if (panelRef.current?.contains(t) === true || anchor?.contains(t) === true) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return (): void => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Merged PRs waiting to deploy"
      className="console-root fixed z-[1000] rounded-[10px] border px-3.5 py-3 text-text-primary shadow-[0_14px_30px_rgba(0,0,0,0.45)]"
      style={{
        top: at?.top ?? 0,
        left: at?.left ?? 0,
        width: `min(${String(POPOVER_WIDTH)}px, calc(100vw - ${String(2 * MARGIN)}px))`,
        visibility: at === null ? 'hidden' : 'visible',
        borderColor: 'var(--border-bright)',
        background: 'var(--surface-elevated)',
      }}
    >
      <h4 className="mb-1.5 text-body font-semibold">
        Merged since {liveSha === null ? 'the live commit' : shortSha(liveSha)}, not yet live
      </h4>
      <ul className="mb-2.5">
        {waiting.prs.map(pr => (
          <li key={pr.number} className="flex gap-2.5 border-t py-1.5 text-body">
            <span className="min-w-10 shrink-0 font-mono text-small text-text-tertiary">
              #{pr.number}
            </span>
            <a
              href={pr.url}
              target="_blank"
              rel="noopener noreferrer"
              className="min-w-0 truncate text-text-secondary hover:text-text-primary hover:underline"
            >
              {pr.title}
            </a>
          </li>
        ))}
        {waiting.more ? (
          <li className="border-t py-1.5 text-body text-text-tertiary">…and more</li>
        ) : null}
      </ul>
      <div className="flex items-center justify-between gap-3 text-small text-text-tertiary">
        <span>{waitingFooter(waiting)}</span>
        <button
          type="button"
          className={PRIMARY}
          disabled={disabled}
          title={actTitle}
          onClick={onDeploy}
        >
          Deploy now
        </button>
      </div>
    </div>,
    document.body
  );
}

function ConfirmDeploy({
  confirm,
  onCancel,
  onDeploy,
}: {
  confirm: DeployConfirm;
  onCancel: () => void;
  onDeploy: () => void;
}): ReactElement {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return (): void => {
      document.removeEventListener('keydown', onKey);
    };
  }, [onCancel]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={confirm.title}
      className="console-root fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
      onMouseDown={onCancel}
    >
      <div
        onMouseDown={e => {
          e.stopPropagation();
        }}
        className="w-[440px] max-w-full rounded-xl border bg-surface-elevated px-5.5 py-5 text-text-primary"
        style={{ borderColor: 'var(--border-bright)' }}
      >
        <h3 className="mb-2 text-[16px] font-semibold">{confirm.title}</h3>
        <p className="mb-4 whitespace-normal text-body text-text-secondary">{confirm.body}</p>
        <div className="flex justify-end gap-2.5">
          <button type="button" className={GHOST} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className={PRIMARY} onClick={onDeploy} autoFocus>
            Deploy now
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
