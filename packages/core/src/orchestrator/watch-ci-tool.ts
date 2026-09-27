import { defineNativeToolInputSchema, type NativeTool } from '@archon/providers/types';
import { createLogger } from '@archon/paths';

const log = createLogger('orchestrator.watch_ci');

export interface WatchCiRequest {
  repo: string;
  headSha: string;
  pullRequest: number | null;
}

export interface WatchCiContext {
  /** The conversation that will be told. Never another one. */
  conversationId: string;
  /** Persist the watch. `created: false` means this chat was already watching that commit. */
  open: (request: WatchCiRequest) => Promise<{ created: boolean }>;
}

const INPUT_SCHEMA = defineNativeToolInputSchema({
  properties: {
    repo: {
      kind: 'string',
      description: 'The GitHub repository the checks run in, as owner/name.',
    },
    sha: {
      kind: 'string',
      description:
        'The full 40-character commit SHA whose checks to wait for — the head of the pull request, or the commit pushed to the branch.',
    },
    pull_request: {
      kind: 'string',
      description: 'Optional pull request number, only to label the message you get back.',
    },
  },
  required: ['repo', 'sha'],
});

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_PATTERN = /^[0-9a-fA-F]{40}$/;
const PR_PATTERN = /^[1-9][0-9]*$/;

function parseRequest(input: Record<string, unknown>): WatchCiRequest | string {
  const { repo, sha, pull_request: pr } = input;
  if (typeof repo !== 'string' || !REPO_PATTERN.test(repo)) {
    return 'repo must be owner/name, e.g. rajababa-io/Archon.';
  }
  // A short SHA cannot be matched against webhook deliveries, which always
  // carry the full one; resolving it is the agent's job, with git.
  if (typeof sha !== 'string' || !SHA_PATTERN.test(sha)) {
    return 'sha must be the full 40-character commit SHA (run `git rev-parse <ref>`).';
  }
  if (pr === undefined || pr === '') return { repo, headSha: sha, pullRequest: null };
  if (typeof pr !== 'string' || !PR_PATTERN.test(pr)) {
    return 'pull_request must be a positive whole number, or left out.';
  }
  return { repo, headSha: sha, pullRequest: Number(pr) };
}

/**
 * Lets a chat hear when CI finishes, after its turn has ended.
 *
 * The in-turn alternatives — a monitor, a background shell, a scheduled wake-up
 * — all die when the turn ends or the container is replaced, so "I'll tell you
 * when CI is done" was a promise nothing kept. This one is a row: a GitHub
 * `check_run` webhook, or the reconcile sweep that backs it up, sends this chat
 * one message when every check on the commit has finished. Until then the rail
 * shows the chat as "Waiting on CI" rather than Idle.
 *
 * Offered only on the web, because the message arrives through the web chat's
 * dispatch; a watch no surface can deliver would be a promise broken quietly.
 */
export function buildWatchCiTool(ctx: WatchCiContext): NativeTool {
  return {
    name: 'watch_ci',
    description:
      'Wait for CI on one commit without staying in this turn. When every GitHub check on that commit has finished, this chat receives one automated message saying which passed and which failed, and a new turn starts to act on it. Use it instead of a monitor, background shell, sleep, or scheduled wake-up — those die when the turn ends. After calling it, end your turn and tell the user you will report back. Watching the same commit twice is one watch.',
    inputSchema: INPUT_SCHEMA,
    handler: async (input): Promise<string> => {
      const request = parseRequest(input);
      if (typeof request === 'string') return `watch_ci error: ${request}`;
      try {
        const { created } = await ctx.open(request);
        log.info(
          { conversationId: ctx.conversationId, repo: request.repo, created },
          'watch_ci.opened'
        );
        const target = `${request.repo}@${request.headSha.slice(0, 7)}`;
        return created
          ? `watch_ci: watching ${target}. This chat gets one message when every check has finished. End your turn now; do not poll.`
          : `watch_ci: this chat was already watching ${target}. Nothing changed.`;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log.error({ err: e, conversationId: ctx.conversationId }, 'watch_ci.failed');
        return `watch_ci error: ${msg}`;
      }
    },
  };
}
