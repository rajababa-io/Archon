import { useState, type ReactElement } from 'react';
import * as skill from '../../../skills';
import type { DeployAnswer, ProjectDeploy } from '../../../skills/deploy';
import { useEntity } from '../../../store/cache';
import { K } from '../../../store/keys';
import { errorDetail } from '../../../lib/http';
import { useLiveChats } from '../../../lib/live-chats';
import { useNow } from '../../../lib/clock';
import {
  PERSON_ONLY_TITLE,
  deployRowView,
  liveMissingLabel,
  type DeployRowRight,
} from '../../../lib/deploy-row';
import { useProjectDeployRefresh } from '../../../hooks/useProjectDeployRefresh';
import { deployConfirmText } from '../../lib/deploy-confirm';

/**
 * A project's deploy on the phone: what is live, what a deploy in flight is
 * doing, and Deploy now behind an inline confirm. The same answer, view and
 * request as the desktop's deploy row; the switch and the waiting list stay
 * on the desktop.
 */
export function DeployCard({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}): ReactElement | null {
  const { data: answer, error } = useEntity<DeployAnswer | null>(K.projectDeploy(projectId), () =>
    skill.getProjectDeploy(projectId)
  );

  if (error !== undefined) {
    return <p className="mobile-note text-error">Couldn&apos;t read the deploy: {error.message}</p>;
  }
  if (answer === undefined) return <p className="mobile-note">Reading the deploy…</p>;
  if (answer === null) return null;
  if (answer.kind === 'not-set-up') {
    return <p className="mobile-note">Deploys are not set up for this project.</p>;
  }
  return <DeployPanel projectId={projectId} projectName={projectName} deploy={answer.deploy} />;
}

function waitingLine(right: DeployRowRight): string {
  switch (right.kind) {
    case 'waiting':
    case 'unknown':
      return right.label;
    case 'up-to-date':
      return 'Up to date';
    case 'none':
      return 'Deploy on Merge is on: merges go live by themselves.';
  }
}

function DeployPanel({
  projectId,
  projectName,
  deploy,
}: {
  projectId: string;
  projectName: string;
  deploy: ProjectDeploy;
}): ReactElement {
  const reload = useProjectDeployRefresh(projectId);
  const { drain } = useLiveChats();
  const now = useNow(
    deploy.method === 'archon-host' && deploy.status.phase !== 'idle' ? 1000 : 30_000
  );
  const view = deployRowView(deploy, drain, now);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const tip = deploy.waiting?.tipSha ?? null;
  const confirm = tip === null ? null : deployConfirmText(deploy, projectName, tip);

  const ship = async (): Promise<void> => {
    if (tip === null) return;
    setBusy(true);
    setFailure(null);
    try {
      await skill.deployNow(projectId, tip);
      setConfirming(false);
    } catch (err) {
      setFailure(errorDetail(err));
    } finally {
      setBusy(false);
      reload();
    }
  };

  return (
    <section
      aria-label="Deploy"
      data-testid="mobile-deploy"
      className="flex flex-col gap-2 rounded-lg border border-border bg-surface-inset px-3 py-2.5"
    >
      <p className="flex items-center gap-2 text-body">
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-success" />
        <span className="text-text-primary">Live</span>
        <span className="min-w-0 truncate font-mono text-small text-text-tertiary">
          {view.live.sha ?? liveMissingLabel(deploy)}
          {view.live.ago !== null ? ` · ${view.live.ago}` : ''}
        </span>
      </p>

      {view.kind === 'deploying' ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-body text-text-secondary">{view.progress}</p>
          <span aria-hidden className="h-1 w-full overflow-hidden rounded-full bg-surface-hover">
            <i
              className={`block h-full bg-[color:var(--running)]${
                view.fraction === null ? ' w-full animate-pulse' : ''
              }`}
              style={
                view.fraction === null ? undefined : { width: `${String(view.fraction * 100)}%` }
              }
            />
          </span>
        </div>
      ) : (
        <>
          <p className="text-small text-text-secondary">{waitingLine(view.right)}</p>
          {view.right.kind === 'waiting' && confirm !== null ? (
            confirming ? (
              <div role="group" aria-label={confirm.title} className="flex flex-col gap-2">
                <p className="text-body font-medium text-text-primary">{confirm.title}</p>
                <p className="text-small text-text-secondary">{confirm.body}</p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setConfirming(false);
                    }}
                    disabled={busy}
                    className="mobile-tap flex-1 rounded-lg border border-border text-body text-text-secondary"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void ship()}
                    disabled={busy}
                    className="mobile-tap flex-1 rounded-lg bg-accent/15 text-body font-medium text-text-primary ring-1 ring-accent ring-inset disabled:opacity-50"
                  >
                    {busy ? 'Deploying…' : 'Deploy now'}
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setFailure(null);
                  setConfirming(true);
                }}
                disabled={view.blocked !== null || !deploy.canAct}
                className="mobile-tap rounded-lg bg-accent/15 text-body font-medium text-text-primary ring-1 ring-accent ring-inset disabled:opacity-50"
              >
                Deploy
              </button>
            )
          ) : null}
          {view.blocked !== null ? (
            <p className="text-small text-text-tertiary">{view.blocked}</p>
          ) : !deploy.canAct ? (
            <p className="text-small text-text-tertiary">{PERSON_ONLY_TITLE}.</p>
          ) : null}
        </>
      )}

      {failure !== null ? (
        <p role="alert" className="text-small text-error">
          {failure}
        </p>
      ) : null}
    </section>
  );
}
