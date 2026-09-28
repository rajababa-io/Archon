/**
 * The numbers a project row shows: how many chats, how many runs, how many of
 * those runs are going right now.
 *
 * Its OWN cache key, deliberately. The obvious shortcut is to reuse `runs:*`,
 * which RunsPage already populates — but that key is fetched there with
 * `limit: RUN_LIMIT` and here it would want `limit: 1`, and two different
 * limits under one key means whichever request lands first decides what the
 * other reader sees. That bug has already been fixed once in this codebase;
 * this is the same shape.
 *
 * It asks for the SMALLEST set of run records that can answer the question —
 * the paused ones — because `counts` covers everything else and the rail must
 * not pay for two hundred run records to draw a number.
 */
import { awaitsApproval } from '@archon/awaiting';
import { requestJson } from '../lib/http';
import { askAwaitingIds } from '../primitives/chat-status';
import { toConversationSummary } from '../primitives/conversation';
import { toRun } from '../primitives/run';

export interface ProjectCounts {
  /**
   * OPEN chats — the ones still in play. Not every chat the project has ever
   * had: a finished chat is history, same as a completed run, and this column
   * means the same kind of thing as the runs column beside it.
   */
  chats: number;
  /**
   * Runs IN PLAY — running, paused or queued. Not the lifetime total.
   *
   * The total was the largest number in the rail and carried the least
   * information: wix-access read 57, of which 45 were completed, 9 failed and
   * 3 cancelled — not one of them needed anything. Meanwhile vault's single
   * executing run was buried inside 22.
   *
   * It also now means the same kind of thing as the chats column beside it,
   * which has always counted ACTIVE chats rather than every chat ever.
   *
   * Failures are deliberately excluded: a failed run is terminal, so it is
   * history until you choose to act on it, and it belongs on the Runs tab.
   */
  runs: number;
  /** Executing right now. */
  running: number;
  /**
   * Things waiting on YOU. Outranks running.
   *
   * Two kinds, counted together because they mean the same thing: a run paused
   * on a gate that is actually ASKING something, and a chat whose last message
   * is an unanswered question. Not `counts.paused` — a run can be paused with
   * nothing pending, and calling that "waiting on you" makes the amber mean
   * "unfinished" instead of "your move". Same rules the chat rail applies per
   * row, so a project and its chats can never disagree.
   */
  awaiting: number;
  /**
   * Platform ids of this project's active chats.
   *
   * Carried so a caller can intersect them with the server's live-chat set and
   * see a chat mid-turn as the PROJECT working. Free — the same response the
   * chat count is read from.
   */
  chatIds: string[];
  /**
   * Open issues, or null when the repo cannot be asked — no repository, a
   * non-GitHub remote, no token, GitHub unreachable. null renders as an empty
   * cell; 0 would claim the repo has no open issues, which is a different
   * statement and often a false one.
   */
  issues: number | null;
}

interface RunsCountsResponse {
  counts?: { all?: number; running?: number; paused?: number; pending?: number; failed?: number };
  total?: number;
  runs?: Parameters<typeof toRun>[0][];
}

export async function getProjectCounts(projectId: string): Promise<ProjectCounts> {
  const q = encodeURIComponent(projectId);
  // Both together: neither blocks the other, and a failure in one must not
  // blank the other's number.
  const [chats, runs, issues] = await Promise.allSettled([
    // `counts` answers the number; the rows are only here for the ids and the
    // unanswered-question check, so this asks for a page rather than the whole
    // listing. Measuring the rows would cap the number at whatever the page
    // held, which is the bug the counts exist to remove.
    requestJson<{
      conversations: Parameters<typeof toConversationSummary>[0][];
      counts: { open: number; done: number; all: number };
    }>(`/api/conversations?codebaseId=${q}&mine=true&archived=active&limit=50`),
    // `status=paused` narrows the RECORDS without narrowing `counts` — the
    // server computes per-status counts across the filtered set minus the
    // status filter — so one request gives both the in-play numbers and the
    // paused runs themselves, which is the only place a pending gate can be
    // read from. 25 is far above the number of runs that can sit paused at
    // once; the exact figure only reaches a tooltip.
    requestJson<RunsCountsResponse>(`/api/dashboard/runs?codebaseId=${q}&status=paused&limit=25`),
    requestJson<{ issues?: { state?: string }[]; reason?: string | null }>(
      `/api/projects/${q}/issues`
    ),
  ]);

  const chatPage = chats.status === 'fulfilled' ? chats.value : null;
  const chatRows = Array.isArray(chatPage?.conversations) ? chatPage.conversations : [];
  // Through the normalizer, not by reaching for the wire fields: which columns
  // carry the platform id and the ask candidate is `primitives/conversation.ts`'s
  // to know.
  const chatSummaries = chatRows.map(toConversationSummary);
  const chatIds = chatSummaries.map(c => c.id).filter(id => id !== '');
  const runsValue = runs.status === 'fulfilled' ? runs.value : null;

  // A route that does not exist yet (or a repo that cannot be asked) means
  // "unknown", not "zero" — the cell stays blank rather than claiming none.
  // A `reason` is that same "could not be asked", delivered as a 200 with an
  // empty list: a rejected token, a non-GitHub remote, no repository at all.
  // Counting those as 0 open issues is the claim this guard exists to refuse.
  const issuesValue = issues.status === 'fulfilled' ? issues.value : null;
  const openIssues =
    issuesValue === null ||
    !Array.isArray(issuesValue.issues) ||
    (issuesValue.reason !== null && issuesValue.reason !== undefined)
      ? null
      : issuesValue.issues.filter(i => i.state === 'OPEN').length;

  const running = runsValue?.counts?.running ?? 0;
  const paused = runsValue?.counts?.paused ?? 0;
  const pending = runsValue?.counts?.pending ?? 0;

  const gatedRuns = (runsValue?.runs ?? []).map(toRun).filter(awaitsApproval).length;
  const unansweredQuestions = askAwaitingIds(chatSummaries).size;

  return {
    chats: chatPage?.counts.open ?? 0,
    chatIds,
    runs: running + paused + pending,
    running,
    awaiting: gatedRuns + unansweredQuestions,
    issues: openIssues,
  };
}
