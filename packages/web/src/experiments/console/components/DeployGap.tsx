/**
 * The Deploy button in the code map's gap between `dev` and `deploy` (#349).
 *
 * Shown only while the project's deploy is behind, or busy: the merged changes
 * that would ship, and one orange button that ships them. After the press it
 * follows the deploy — pending, waiting on chats, building — and then says the
 * new commit is live only once the server's Live commit is that commit.
 *
 * It reads the same deploy answer as the header's DeployRow (same cache key, no
 * second request) and ships through the same `deployNow`, with the same confirm
 * when running chats would be paused. There is one deploy path; this is a
 * second place to press it. The deploy still waits for a quiet moment — the
 * button asks for a deploy, it never forces the swap.
 */

import { useEffect, useState, type ReactElement } from 'react';
import * as skill from '../skills';
import type { DeployAnswer } from '../skills/deploy';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';
import { useLiveChats } from '../lib/live-chats';
import { useNow } from '../lib/clock';
import { useProjectDeployRefresh } from '../hooks/useProjectDeployRefresh';
import { PERSON_ONLY_TITLE, deployConfirm, type DeployConfirm } from '../lib/deploy-row';
import { deployGapView, deployingSha, type DeployGapView } from '../lib/deploy-gap';
import { ConfirmDeploy, actionError } from './DeployRow';

/** How long "live abc1234" stays after a deploy lands, before the gap closes. */
const DEPLOYED_MS = 60_000;
/** How long a press holds the button greyed while the server has not yet shown the deploy. */
const PRESSED_MS = 30_000;
/** How many waiting changes the list names before it says "and N more". */
const LIST_MAX = 5;

const ORANGE = 'var(--status-awaiting)';

interface DeployGapProps {
  projectId: string;
  projectName: string;
}

export function DeployGap({ projectId, projectName }: DeployGapProps): ReactElement | null {
  const { data: answer } = useEntity<DeployAnswer | null>(K.projectDeploy(projectId), () =>
    skill.getProjectDeploy(projectId)
  );
  const deploy = answer?.kind === 'set-up' ? answer.deploy : null;
  const { drain } = useLiveChats();
  const now = useNow(1_000);
  const reload = useProjectDeployRefresh(projectId);

  // The commit a deploy seen on this page carried, kept past its end so the
  // gap can check Live against it. Null until a deploy is seen running.
  const [shipped, setShipped] = useState<string | null>(null);
  // The tip pressed here, until the server shows the deploy it asked for.
  const [pressed, setPressed] = useState<string | null>(null);
  const carrying = deployingSha(deploy);
  const running =
    deploy !== null &&
    ((deploy.method === 'archon-host' && deploy.status.phase !== 'idle') ||
      (deploy.method === 'workflow' && deploy.run !== null));
  useEffect(() => {
    if (!running) return;
    const sha = carrying ?? pressed;
    if (sha !== null) setShipped(sha);
    setPressed(null);
  }, [running, carrying, pressed]);

  // A request the server took but never shows as running — refused later, or
  // already undone — must not hold the button greyed for good. The re-read
  // after the press lands well inside this; past it, the server's idle answer
  // is the truth and the button comes back.
  useEffect(() => {
    if (pressed === null) return;
    const id = setTimeout(() => {
      setPressed(null);
    }, PRESSED_MS);
    return (): void => {
      clearTimeout(id);
    };
  }, [pressed]);

  const view = deployGapView(deploy, drain, now, running ? null : shipped);

  useEffect(() => {
    if (view.kind !== 'deployed' && view.kind !== 'not-live') return;
    const id = setTimeout(() => {
      setShipped(null);
    }, DEPLOYED_MS);
    return (): void => {
      clearTimeout(id);
    };
  }, [view.kind]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<DeployConfirm | null>(null);

  if (deploy === null || view.kind === 'hidden') return null;

  const ship = (tip: string): void => {
    setConfirm(null);
    setError(null);
    setBusy(true);
    setPressed(tip);
    skill
      .deployNow(projectId, tip)
      .catch((err: unknown) => {
        setPressed(null);
        setError(actionError(err));
      })
      .finally(() => {
        setBusy(false);
        reload();
      });
  };

  const start = (tip: string): void => {
    // Only the host deploy pauses running work, which is all the confirm is about.
    const ask = deploy.method === 'archon-host' ? deployConfirm(projectName, deploy.running) : null;
    if (ask === null) ship(tip);
    else setConfirm(ask);
  };

  return (
    <>
      <DeployGapPanel
        view={view}
        requested={busy || pressed !== null}
        canAct={deploy.canAct}
        error={error}
        onDeploy={start}
      />
      {confirm !== null && view.kind === 'behind' ? (
        <ConfirmDeploy
          confirm={confirm}
          onCancel={() => {
            setConfirm(null);
          }}
          onDeploy={() => {
            ship(view.tipSha);
          }}
        />
      ) : null}
    </>
  );
}

interface DeployGapPanelProps {
  view: Exclude<DeployGapView, { kind: 'hidden' }>;
  /** A press is in flight, or the server has not yet shown the deploy it asked for. */
  requested: boolean;
  canAct: boolean;
  error: string | null;
  onDeploy: (tipSha: string) => void;
}

/** The gap's markup, apart from the data it reads, so the preview can draw every state. */
export function DeployGapPanel({
  view,
  requested,
  canAct,
  error,
  onDeploy,
}: DeployGapPanelProps): ReactElement {
  return (
    <div data-testid="deploy-gap" className="flex flex-wrap items-start gap-x-6 gap-y-3 py-2">
      {view.kind === 'behind' ? (
        <>
          <div className="flex flex-col items-center gap-1.5">
            <button
              type="button"
              disabled={requested || !canAct || view.blocked !== null}
              title={view.blocked ?? (canAct ? undefined : PERSON_ONLY_TITLE)}
              onClick={() => {
                onDeploy(view.tipSha);
              }}
              className="rounded-full px-4.5 py-1.75 text-body font-semibold text-black transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              style={{ background: ORANGE }}
            >
              {requested ? 'Requested…' : `${view.label} ↓`}
            </button>
            <span className="max-w-[220px] text-center text-mini text-text-tertiary">
              waits for a quiet moment, then shows what is running
            </span>
            {error !== null ? <span className="text-small text-error">{error}</span> : null}
          </div>
          {view.prs.length > 0 ? (
            <ul
              data-testid="deploy-gap-list"
              className="flex min-w-0 flex-col gap-1 rounded-lg border bg-surface-inset px-3 py-2 text-small"
            >
              {view.prs.slice(0, LIST_MAX).map(pr => (
                <li key={pr.number} className="flex min-w-0 items-center gap-2">
                  <span
                    aria-hidden
                    className="size-2 shrink-0 rounded-full"
                    style={{ background: 'var(--status-ready)' }}
                  />
                  <a
                    href={pr.url}
                    target="_blank"
                    rel="noreferrer"
                    className="min-w-0 truncate text-text-primary hover:underline"
                  >
                    <span className="text-text-tertiary">#{String(pr.number)}</span> {pr.title}
                  </a>
                </li>
              ))}
              {view.prs.length > LIST_MAX || view.more ? (
                <li className="text-text-tertiary">
                  and {view.more ? 'more' : `${String(view.prs.length - LIST_MAX)} more`}
                </li>
              ) : null}
            </ul>
          ) : null}
        </>
      ) : null}

      {view.kind === 'deploying' ? (
        <div className="flex min-w-[260px] flex-col gap-1.5" aria-live="polite">
          <span className="h-1.5 w-full overflow-hidden rounded-full bg-surface-hover">
            <i
              className={`block h-full${view.fraction === null ? ' w-full animate-pulse' : ''}`}
              style={{
                background: 'var(--status-done)',
                ...(view.fraction === null ? {} : { width: `${String(view.fraction * 100)}%` }),
              }}
            />
          </span>
          <span className="text-small text-text-secondary">
            {view.pending ? (
              <span className="font-medium" style={{ color: ORANGE }}>
                Pending ·{' '}
              </span>
            ) : null}
            {view.progress}
          </span>
        </div>
      ) : null}

      {view.kind === 'deployed' ? (
        <span className="text-small text-text-secondary" aria-live="polite">
          <span className="font-medium" style={{ color: 'var(--status-done)' }}>
            Deployed
          </span>{' '}
          · live <span className="font-mono">{view.sha}</span>
        </span>
      ) : null}

      {view.kind === 'not-live' ? (
        <span className="text-small text-error" aria-live="polite">
          Deploy of <span className="font-mono">{view.target}</span> did not go live · still running{' '}
          <span className="font-mono">{view.live ?? 'an unknown commit'}</span> — see the deploy log
        </span>
      ) : null}
    </div>
  );
}
