import { AlertTriangle, ArrowRight, Check, ExternalLink, MessageCircle } from 'lucide-react';
import { useMemo, type ReactElement } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ActiveRunCard } from '../components/ActiveRunCard';
import { EmptyState } from '../components/EmptyState';
import { ProjectBriefCard } from '../components/ProjectBriefCard';
import { issueType } from '../primitives/issue-board';
import { conversationLabel } from '../primitives/conversation';
import type { Run } from '../primitives/run';
import { relativeTime } from '../lib/format';
import { DEPLOY_LOG_LABEL } from '../lib/deploy-row';
import { shortSha } from '../lib/deploy-strip';
import * as skill from '../skills';
import type { DeployAnswer, DeployLogEntry, GithubIssue, IssuesResponse } from '../skills';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';
import { IssueTypeChip } from '../components/IssueTypeChip';
import { useNow } from '../lib/clock';
import { stalledIds } from '../primitives/stalled';

function Section({
  label,
  action,
  children,
}: {
  label: string;
  action?: ReactElement | null;
  children: ReactElement | ReactElement[];
}): ReactElement {
  return (
    <section className="flex flex-col gap-x-2 gap-y-1.25">
      <div className="flex items-center gap-2">
        <h2 className="text-mini font-medium text-text-tertiary">{label}</h2>
        {action !== undefined && action !== null ? <span className="ml-auto">{action}</span> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * Where a project is, and what to do about it.
 *
 * Ported from the prototype, with its ordering: the thing only YOU can clear
 * comes first, then what is executing, then what is open.
 *
 * Below that it reads runs, chats, issues — the same order as the project's
 * tabs and the rail's count columns. Three places showing the same three
 * things in three different orders is three things to learn instead of one.
 *
 * State, not events — "completed 56" is a lifetime counter and nothing you do
 * changes because of it, so it does not appear.
 */
export function OverviewPage(): ReactElement {
  const { projectId = '' } = useParams<{ projectId: string }>();
  const navigate = useNavigate();

  const { data: feed } = useEntity<{ runs: Run[] }>(K.runs(projectId), () =>
    skill.listRuns({ codebaseId: projectId, limit: skill.RUN_LIMIT })
  );
  const { data: issueData } = useEntity<IssuesResponse>(K.issues(projectId), () =>
    skill.listIssues(projectId)
  );
  // Open chats, not every chat: the overview is where you resume, and a
  // finished one is not something to resume.
  const { data: chatList } = useEntity<skill.ConversationList>(
    `${K.conversations(projectId)}:open`,
    () => skill.listConversations(projectId, 'open')
  );
  const chats = chatList?.chats;
  // The header reads the same key, so this costs no request; the log is asked
  // for only once it is known the project has a deploy to log.
  const { data: deploy } = useEntity<DeployAnswer | null>(K.projectDeploy(projectId), () =>
    skill.getProjectDeploy(projectId)
  );
  const hasDeploy = deploy?.kind === 'set-up';
  const { data: deployLog } = useEntity<DeployLogEntry[]>(
    hasDeploy ? K.projectDeployLog(projectId) : 'noop:no-deploy-log',
    () => (hasDeploy ? skill.getProjectDeployLog(projectId) : Promise.resolve([]))
  );

  const runs = feed?.runs ?? [];
  const now = useNow();
  const stalled = useMemo(() => stalledIds(runs, now), [runs, now]);
  const inFlight = useMemo(() => runs.filter(r => r.status === 'running'), [runs]);
  // Only a human can clear these: a run paused on an approval or an input
  // request. Everything else is the machine's problem.
  const needsYou = useMemo(() => runs.filter(r => r.status === 'paused'), [runs]);
  const openIssues = useMemo<GithubIssue[]>(
    () => (issueData?.issues ?? []).filter(i => i.state === 'OPEN'),
    [issueData]
  );

  const byType = useMemo(() => {
    const out = new Map<string, number>();
    for (const i of openIssues) {
      const t = issueType(i)?.name ?? 'Untyped';
      out.set(t, (out.get(t) ?? 0) + 1);
    }
    return [...out.entries()].sort((a, b) => b[1] - a[1]);
  }, [openIssues]);

  if (projectId === '') return <EmptyState title="No project." />;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6.25 pb-6.25 pt-3">
      <div className="mx-auto flex max-w-[860px] flex-col gap-x-5.25 gap-y-4.25">
        {/* 1 — what this is. The standing answer, above everything that moves. */}
        <Section label="Where this project is">
          <ProjectBriefCard projectId={projectId} />
        </Section>

        {/* 2 — the only section whose best answer is empty. */}
        <Section
          label="Needs you"
          action={
            needsYou.length > 0 ? (
              <span className="inline-flex items-center gap-1.5 text-small font-medium text-[color:var(--warning,oklch(0.78_0.15_80))]">
                <AlertTriangle className="h-3 w-3" />
                {needsYou.length}
              </span>
            ) : null
          }
        >
          {needsYou.length === 0 ? (
            <p className="flex items-center gap-2 text-body text-text-secondary">
              <Check className="h-4 w-4 text-[color:var(--success)]" />
              Nothing is waiting on you.
            </p>
          ) : (
            <div className="flex flex-col gap-x-2 gap-y-1.25">
              {needsYou.map(r => (
                <ActiveRunCard
                  key={r.id}
                  run={r}
                  showProject={false}
                  selected={false}
                  stalled={stalled.has(r.id)}
                />
              ))}
            </div>
          )}
        </Section>

        {/* 2 — what is executing, not that something started two hours ago. */}
        {inFlight.length > 0 ? (
          <Section label="In flight">
            <div className="flex flex-col gap-x-2 gap-y-1.25">
              {inFlight.map(r => (
                <ActiveRunCard
                  key={r.id}
                  run={r}
                  showProject={false}
                  selected={false}
                  stalled={stalled.has(r.id)}
                />
              ))}
            </div>
          </Section>
        ) : (
          <></>
        )}

        {/* 3 — the chats, because the overview is also where you resume. */}
        <Section
          label="Chats"
          action={
            <Link
              to={`/console/p/${projectId}/chat`}
              className="rounded border border-border px-2 py-0.5 text-mini text-text-secondary transition-colors hover:border-border-bright hover:text-text-primary"
            >
              Open
            </Link>
          }
        >
          {(chats ?? []).length === 0 ? (
            <p className="text-body text-text-tertiary">No chats yet.</p>
          ) : (
            <div className="flex flex-col overflow-hidden rounded-lg border border-border">
              {(chats ?? []).slice(0, 5).map(c => (
                <Link
                  key={c.id}
                  to={`/console/p/${projectId}/chat`}
                  className="group flex items-center gap-2 border-b border-border px-3 py-1.25 last:border-b-0 hover:bg-surface-hover"
                >
                  <MessageCircle className="h-[14px] w-[14px] shrink-0 text-text-tertiary" />
                  <span className="min-w-0 flex-1 truncate text-body text-text-secondary group-hover:text-text-primary">
                    {conversationLabel(c)}
                  </span>
                  {c.lastActivityAt !== null ? (
                    <time
                      dateTime={c.lastActivityAt}
                      className="shrink-0 text-mini text-text-tertiary"
                    >
                      {relativeTime(c.lastActivityAt)}
                    </time>
                  ) : null}
                </Link>
              ))}
            </div>
          )}
        </Section>

        {/* The deploy's own history — who pressed what, and how each deploy
            ended. Only for a project that deploys. */}
        {hasDeploy ? (
          <Section label="Deploys">
            {deployLog === undefined ? (
              <p className="text-body text-text-tertiary">Loading…</p>
            ) : deployLog.length === 0 ? (
              <p className="text-body text-text-tertiary">Nothing logged yet.</p>
            ) : (
              <div className="flex flex-col overflow-hidden rounded-lg border border-border">
                {deployLog.slice(0, 10).map(entry => (
                  <div
                    key={`${entry.at}:${entry.kind}:${entry.sha ?? ''}`}
                    className="flex items-center gap-2 border-b border-border px-3 py-1.25 last:border-b-0"
                  >
                    <time
                      dateTime={entry.at}
                      className="w-14 shrink-0 text-mini text-text-tertiary"
                    >
                      {relativeTime(entry.at)}
                    </time>
                    <span className="shrink-0 text-body text-text-secondary">
                      {DEPLOY_LOG_LABEL[entry.kind]}
                    </span>
                    {entry.sha !== null ? (
                      <code className="shrink-0 text-mini text-text-tertiary">
                        {shortSha(entry.sha)}
                      </code>
                    ) : null}
                    {entry.detail !== null ? (
                      <span
                        title={entry.detail}
                        className="min-w-0 flex-1 truncate text-mini text-text-tertiary"
                      >
                        {entry.detail}
                      </span>
                    ) : (
                      <span className="flex-1" />
                    )}
                    {entry.actor !== null ? (
                      <span className="shrink-0 text-mini text-text-tertiary">{entry.actor}</span>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </Section>
        ) : (
          <></>
        )}

        {/* 4 — state, by type. */}
        <Section
          label="Backlog"
          action={
            <Link
              to={`/console/p/${projectId}/issues`}
              className="rounded border border-border px-2 py-0.5 text-mini text-text-secondary transition-colors hover:border-border-bright hover:text-text-primary"
            >
              Board
            </Link>
          }
        >
          {openIssues.length === 0 ? (
            <p className="text-body text-text-tertiary">
              {issueData?.reason !== null && issueData?.reason !== undefined
                ? 'No issues to show for this project.'
                : 'No open issues.'}
            </p>
          ) : (
            <>
              <div className="flex flex-wrap gap-1.5">
                {byType.map(([t, n]) => (
                  <IssueTypeChip
                    key={t}
                    name={t}
                    count={n}
                    title={`${String(n)} open ${t.toLowerCase()} issue${n === 1 ? '' : 's'}`}
                    onClick={() => {
                      navigate(`/console/p/${projectId}/issues`);
                    }}
                  />
                ))}
              </div>
              <div className="flex flex-col overflow-hidden rounded-lg border border-border">
                {openIssues.slice(0, 4).map(i => (
                  <a
                    key={i.number}
                    href={i.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group flex items-center gap-2 border-b border-border px-3 py-1.25 last:border-b-0 hover:bg-surface-hover"
                  >
                    <span className="shrink-0 text-mini text-text-tertiary">#{i.number}</span>
                    <span className="min-w-0 flex-1 truncate text-body text-text-secondary group-hover:text-text-primary">
                      {i.title}
                    </span>
                    <ExternalLink className="h-3 w-3 shrink-0 text-text-tertiary opacity-0 group-hover:opacity-100" />
                  </a>
                ))}
                {openIssues.length > 4 ? (
                  <Link
                    to={`/console/p/${projectId}/issues`}
                    className="flex items-center gap-1.5 px-3 py-1.25 text-body text-text-tertiary hover:text-text-primary"
                  >
                    {openIssues.length - 4} more on the board
                    <ArrowRight className="h-3 w-3" />
                  </Link>
                ) : null}
              </div>
            </>
          )}
        </Section>
      </div>
    </div>
  );
}
