/**
 * What the deploy replacing this server is doing, across the top of the console.
 *
 * WHY IT IS HERE AT ALL. A deploy on this install takes five to twenty minutes,
 * and until this strip existed the person who asked for it could see nothing.
 * The obvious workaround — asking the agent — is the bug: a deploy drains the box
 * before it swaps the container, waiting for the turns already in flight to
 * finish, and a question is a turn. On 2026-09-25 a chat that woke every twenty
 * minutes to check held the drain for 3116 seconds and the deploy failed; left
 * alone, the same commit went live in eleven minutes. So this reads `/api/health`
 * over plain HTTP, on the poll the rail already makes, and takes no conversation
 * lock at any point.
 *
 * WHY IT IS IN THE PROJECT HEADER, AND NOT A BAND OF ITS OWN. It sat at the foot
 * of the rail first, where a phone could not reach it — the rail is a drawer that
 * is closed by default below `md`. The fix for that was a full-width band above
 * everything, and the band was worse in a way the rail never was: it is a flex
 * child of the app shell, so it appeared with the first health answer and pushed
 * the entire console down a line. Every load jiggled.
 *
 * This slot cannot do that. `ProjectHeader`'s top row already exists on every
 * frame and its height is set by the project name, which is `text-title` against
 * this strip's 11px — so the strip fills horizontal space the row was already
 * spending on nothing, and can neither move what is beside it (the name
 * truncates, the strip takes the slack as `flex-1`) nor change the row's height.
 * Rendering nothing is the same shape as rendering something.
 *
 * WHAT IT COSTS. `ProjectHeader` draws it on All projects only (#319): on a
 * project's page the row reads as that project's, and Archon's "Deploy failed"
 * beside another project's name was taken for that project's failure. The
 * Archon project's own deploy row reports the same deploy, so the ambient half
 * lives on those two screens and nowhere else. That is a real narrowing from
 * the band, taken deliberately: a surface that shifts the page on every load
 * gets dismissed, and a dismissed surface reports nothing anywhere.
 * DeployOverlay is still mounted app-wide in ConsoleApp, so the two phases that
 * actually stop you still interrupt on every route — it is the ambient half
 * that is scoped, not the urgent half.
 *
 * WHAT IT DROPS ON A NARROW SCREEN. The dot, the phase word and the clock survive
 * every width; the SHA goes below `sm` and the holding sentence below `md`, and
 * the sentence is capped at 22 characters above that so a long FAILED reason
 * cannot crowd the project name. That ordering is deliberate — the clock is what
 * tells you the deploy is alive, and the phase word is what tells you whether you
 * can type. DeployOverlay picks up the phases where the detail actually matters.
 *
 * It renders in the idle state too, quietly. A strip that appeared only during a
 * deploy could not be trusted to be absent for the right reason — "nothing on
 * screen" is also what a broken indicator looks like. The one state it renders
 * nothing for is not knowing: before the first answer, and on a server that
 * could not read its own deploy files.
 */

import { type ReactElement } from 'react';
import { type DeployTone, deployStripView } from '../lib/deploy-strip';
import { relativeTime } from '../lib/format';
import { useDeployElapsed, useDeployStatus } from '../lib/live-deploy';

const TONE_DOT: Record<DeployTone, string> = {
  live: 'bg-[color:var(--running)] animate-pulse',
  ok: 'bg-success/60',
  bad: 'bg-error',
  quiet: 'bg-text-tertiary/40',
};

const TONE_TEXT: Record<DeployTone, string> = {
  live: 'text-text-primary',
  ok: 'text-text-secondary',
  bad: 'text-error',
  quiet: 'text-text-tertiary',
};

export function DeployStrip(): ReactElement | null {
  const { status } = useDeployStatus();
  const view = status === undefined ? null : deployStripView(status);
  const elapsed = useDeployElapsed(view?.startedAt ?? null);

  if (view === null) return null;

  const ago = view.verdictAt === null ? null : relativeTime(view.verdictAt);
  // One sentence for a screen reader, because the visual version is a dot, two
  // weights of text and a clock, and none of that reads aloud in order.
  const spoken = [view.label, view.detail, view.sha, elapsed ?? ago]
    .filter((part): part is string => part !== null)
    .join(' — ');

  return (
    <div
      data-testid="deploy-strip"
      className="flex min-w-0 flex-1 items-center justify-end gap-2 self-center text-small leading-none"
      aria-live="polite"
    >
      <span
        aria-hidden="true"
        className={`inline-block size-2 shrink-0 rounded-full ${TONE_DOT[view.tone]}`}
      />
      <span className={`shrink-0 font-medium ${TONE_TEXT[view.tone]}`}>{view.label}</span>
      {view.sha !== null ? (
        <code className="hidden shrink-0 tabular-nums text-text-tertiary sm:inline">
          {view.sha}
        </code>
      ) : null}
      {view.detail !== null ? (
        <span className="hidden min-w-0 max-w-[22ch] truncate text-text-tertiary md:inline">
          {view.detail}
        </span>
      ) : null}
      {elapsed !== null ? (
        <span className="shrink-0 tabular-nums text-text-tertiary">{elapsed}</span>
      ) : null}
      {elapsed === null && ago !== null ? (
        <span className="shrink-0 text-text-tertiary">{ago}</span>
      ) : null}
      <span className="sr-only">Deploy: {spoken}</span>
    </div>
  );
}
