/**
 * The words the deploy strip shows, worked out separately from the markup.
 *
 * The rule this whole surface rests on: it never states something it cannot
 * prove. The server answers `unknown` when it cannot follow its own deploy log,
 * and this does not turn that into a confident phase — a strip that reads
 * "healthy" during a failed deploy is worse than no strip at all.
 *
 * `healthy` is the one word here the server does not itself use. It means the
 * narrow thing it can prove: nothing is in flight and the last recorded verdict
 * was OK. A box whose last deploy FAILED reads as failed, not as idle.
 */

import type { DeployStatus } from '../skills/activeChats';

/** How the strip should read — the colour it carries and the weight it has. */
export type DeployTone =
  /** A deploy is happening now. */
  | 'live'
  /** Nothing in flight and the last attempt succeeded. */
  | 'ok'
  /** The last attempt failed, was killed, or was refused. */
  | 'bad'
  /** Nothing in flight and nothing wrong — including a merge the policy held. */
  | 'quiet';

export interface DeployStripView {
  tone: DeployTone;
  /** The phase, in a word or two. */
  label: string;
  /** What the phase is waiting on or what the verdict said. Null when there is nothing to add. */
  detail: string | null;
  /** Set only while an attempt is in flight, and only then does elapsed time mean anything. */
  startedAt: string | null;
  /** The commit, shortened when it is one. Null when there is no commit to name. */
  sha: string | null;
  /** When the last verdict was recorded, for a relative time. Null while in flight. */
  verdictAt: string | null;
}

/**
 * Shorten a commit, and only a commit.
 *
 * `record()` writes `<empty>` and `?` into the history when it could not read
 * the request, and truncating those to eight characters would invent a SHA out
 * of a placeholder.
 */
export function shortSha(sha: string): string {
  return /^[0-9a-f]{40}$/u.test(sha) ? sha.slice(0, 8) : sha;
}

const VERDICT_LABEL: Record<NonNullable<DeployStatus['last']>['verdict'], string> = {
  OK: 'Healthy',
  FAILED: 'Deploy failed',
  KILLED: 'Deploy stopped',
  REFUSED: 'Deploy refused',
  HELD: 'Deploy held',
};

/** The step, as the strip names it: `4/7 Build`. */
function stepDetail(step: DeployStatus['step']): string | null {
  if (step === undefined) return null;
  return `${String(step.number)}/${String(step.of)} ${step.name}`;
}

function inFlightView(status: DeployStatus): DeployStripView {
  const base = {
    tone: 'live' as const,
    startedAt: status.startedAt ?? null,
    sha: status.sha === undefined ? null : shortSha(status.sha),
    verdictAt: null,
  };
  switch (status.phase) {
    case 'requested':
      return { ...base, label: 'Deploy requested', detail: 'waiting for the host to start' };
    case 'building':
      return { ...base, label: 'Building', detail: stepDetail(status.step) };
    case 'draining':
      // The holding sentence is the server's own, not a rephrasing: "1 chat
      // mid-turn" is what the deploy log says and what the person watching
      // needs, because one of those chats may be theirs.
      return {
        ...base,
        label: 'Draining',
        detail:
          status.holding === undefined
            ? 'waiting for the box to finish what it holds'
            : `waiting for ${status.holding}`,
      };
    case 'swapping':
      return { ...base, label: 'Swapping', detail: 'restarting and waiting for health' };
    case 'verifying':
      return { ...base, label: 'Verifying', detail: 'asking the new container which commit it is' };
    default:
      // Reached for `unknown`, and for a phase a newer server invented. Saying
      // a deploy is running is provable — the log is open and no verdict has
      // been recorded. Naming its phase is not.
      return { ...base, label: 'Deploying', detail: 'phase unknown' };
  }
}

export function deployStripView(status: DeployStatus): DeployStripView {
  if (status.phase !== 'idle') return inFlightView(status);

  const last = status.last;
  if (last === undefined) {
    // No history at all, which is what a fresh install looks like.
    return {
      tone: 'quiet',
      label: 'No deploys',
      detail: null,
      startedAt: null,
      sha: null,
      verdictAt: null,
    };
  }
  return {
    // HELD is the policy declining to ship a merge (Deploy on Merge is off),
    // which is the switch working, not a failure to report in red.
    tone: last.verdict === 'OK' ? 'ok' : last.verdict === 'HELD' ? 'quiet' : 'bad',
    label: VERDICT_LABEL[last.verdict],
    detail: last.reason ?? null,
    startedAt: null,
    sha: shortSha(last.sha),
    verdictAt: last.at,
  };
}

/**
 * How hard a phase has to interrupt, when it has to interrupt at all.
 *
 * The header strip is ambient and always there; this is the second surface, and
 * it exists for the two phases where the strip is too quiet — the phases that
 * change what the app can actually do. It is deliberately narrow:
 *
 * - `swapping` is `blocking`. The container is being recreated and HTTP fails,
 *   so there is nothing underneath worth reaching. Covering it costs nothing.
 * - `draining` is a `notice`. Drain refuses exactly one thing — taking the
 *   conversation lock, which is sending a message. Reading is untouched, so an
 *   overlay that stopped someone opening a chat would be taking away something
 *   that still works.
 * - Everything else gets nothing. `building` especially: steps 1-4 leave the app
 *   completely usable, and blurring it then is the same lie this whole surface
 *   was built to avoid — it would train the reader to dismiss it.
 * - `unknown` gets nothing either, for the reason `inFlightView` names: a phase
 *   we cannot prove must not drive a claim about what the app can do.
 */
export type DeployInterruptionKind =
  /** The app cannot serve. Cover it. */
  | 'blocking'
  /** The app still serves reads. Explain, but stay out of the way. */
  | 'notice';

export interface DeployInterruption {
  kind: DeployInterruptionKind;
  /** The phase, as a heading. */
  title: string;
  /** What is happening, in one sentence. */
  body: string;
  /** What a reader can still do. Null when the answer is nothing. */
  stillWorks: string | null;
}

export function deployInterruption(status: DeployStatus): DeployInterruption | null {
  switch (status.phase) {
    case 'draining':
      return {
        kind: 'notice',
        title: 'Draining before the swap',
        body:
          status.holding === undefined
            ? 'The deploy is waiting for the box to finish what it holds. New messages are refused until it does; turns already in flight finish normally.'
            : `The deploy is waiting for ${status.holding}. New messages are refused until it does; turns already in flight finish normally.`,
        stillWorks: 'Reading still works — chats, runs and files are all reachable.',
      };
    case 'swapping':
      return {
        kind: 'blocking',
        title: 'Swapping the container',
        body: 'The server is being replaced. This page will fail to load anything until the new container answers, which usually takes one to three minutes.',
        stillWorks: null,
      };
    default:
      return null;
  }
}
