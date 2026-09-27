/**
 * The second deploy surface: the one for the phases that actually stop you.
 *
 * The header strip is ambient — an 11px line that is right all day and costs
 * nothing to ignore. That is exactly wrong for the two phases where the app
 * cannot do what you are about to ask of it, so those get a card in the middle
 * of the screen, sized to be read across a room on a tablet.
 *
 * WHICH PHASES, AND WHY ONLY THOSE. `lib/deploy-strip.deployInterruption` owns
 * that decision and states the reasoning; this file only renders what it
 * returns. The short version: `swapping` blocks because HTTP fails anyway,
 * `draining` explains without blocking because drain refuses sending and
 * nothing else, and every other phase — `building` above all — gets nothing.
 *
 * WHAT THE `notice` KIND DOES NOT DO. It does not blur, does not dim to the
 * point of unreadability, and does not take pointer events: the scrim is
 * `pointer-events-none` and only the card itself is interactive. Drain lasts
 * anywhere from seconds to twenty minutes, and for all of it chats, runs and
 * files still load. An overlay that stopped someone reading a run during a
 * drain would be taking away something that still works. It is dismissible for
 * the same reason, and the header strip carries the phase after a dismissal.
 *
 * The composer is not disabled here. The server refuses a send during drain with
 * its own reason (`refused-draining` in `routes/api.ts`), which is the honest
 * place for it; a client-side guess at the lock state would be a second opinion
 * about a fact only the server holds.
 *
 * Like the strip, this reads the shared `/api/health` poll and takes no
 * conversation turn. Watching a deploy must never be one of the things the
 * deploy waits for.
 */

import { useState, type ReactElement } from 'react';
import { deployInterruption, deployStripView } from '../lib/deploy-strip';
import { useDeployElapsed, useDeployStatus } from '../lib/live-deploy';

export function DeployOverlay(): ReactElement | null {
  const { status } = useDeployStatus();
  const interruption = status === undefined ? null : deployInterruption(status);
  const view = status === undefined ? null : deployStripView(status);
  const elapsed = useDeployElapsed(view?.startedAt ?? null);

  // A dismissal names the attempt AND the phase it was made in, so it expires
  // by itself rather than needing an effect to clear it: dismissing the drain
  // notice does not also hide the swap that follows (a different fact, and that
  // one means the page is about to stop working), and it does not carry over
  // into the next deploy's drain either.
  const dismissKey = status === undefined ? null : `${status.startedAt ?? ''}:${status.phase}`;
  const [dismissed, setDismissed] = useState<string | null>(null);

  if (interruption === null || view === null) return null;
  // A blocking phase cannot be dismissed: there is nothing underneath to get
  // back to, so a dismiss button would be an offer the app cannot honour.
  if (interruption.kind === 'notice' && dismissed === dismissKey) return null;

  const blocking = interruption.kind === 'blocking';

  return (
    <div
      data-testid="deploy-overlay"
      data-kind={interruption.kind}
      role={blocking ? 'alertdialog' : 'status'}
      aria-live={blocking ? 'assertive' : 'polite'}
      aria-labelledby="deploy-overlay-title"
      aria-describedby="deploy-overlay-body"
      className={`fixed inset-0 z-50 flex items-center justify-center p-4 ${
        blocking ? 'bg-black/70 backdrop-blur-md' : 'pointer-events-none bg-black/20'
      }`}
    >
      <div
        className={`pointer-events-auto w-full max-w-md rounded-lg border px-4 py-2.5 shadow-2xl ${
          blocking ? 'border-error/50 bg-surface' : 'border-border bg-surface'
        }`}
      >
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="inline-block size-3 shrink-0 animate-pulse rounded-full bg-[color:var(--running)]"
          />
          <h2
            id="deploy-overlay-title"
            className="min-w-0 flex-1 text-title font-semibold text-text-primary"
          >
            {interruption.title}
          </h2>
          {elapsed !== null ? (
            <span className="shrink-0 tabular-nums text-large text-text-tertiary">{elapsed}</span>
          ) : null}
        </div>
        <p
          id="deploy-overlay-body"
          className="mt-2.5 text-large leading-relaxed text-text-secondary"
        >
          {interruption.body}
        </p>
        {interruption.stillWorks !== null ? (
          <p className="mt-2 text-large leading-relaxed text-text-tertiary">
            {interruption.stillWorks}
          </p>
        ) : null}
        <div className="mt-2 flex items-center gap-2.25">
          {view.sha !== null ? (
            <code className="tabular-nums text-small text-text-tertiary">{view.sha}</code>
          ) : null}
          <span className="flex-1" />
          {blocking ? null : (
            <button
              type="button"
              onClick={() => {
                setDismissed(dismissKey);
              }}
              className="rounded border border-border px-3 py-1.5 text-large text-text-secondary"
            >
              Keep reading
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
