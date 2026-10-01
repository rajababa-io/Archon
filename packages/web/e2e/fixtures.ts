/**
 * The world the console is loaded against in the browser suite.
 *
 * Every shape here is the console's OWN wire shape, taken from the module that
 * owns it — the generated OpenAPI types for routes the spec describes, and the
 * `Raw*` parameter of the normalizer for routes it does not. Nothing is
 * restated by hand, so a server-side rename fails `tsc` here instead of leaving
 * a fixture that quietly stops resembling the server.
 *
 * The data is deliberately small and fixed: four assertions need a project, a
 * chat, a transcript, and one ask block. A fixture that grows past what a test
 * reads is a fixture nobody can tell is wrong.
 */
import type { components } from '@/lib/api.generated';
import type { toProject } from '@/experiments/console/primitives/project';
import type { toConversationSummary } from '@/experiments/console/primitives/conversation';
import type { toMessage } from '@/experiments/console/primitives/message';
import type { toRun } from '@/experiments/console/primitives/run';
import type { toRunEvent } from '@/experiments/console/primitives/event';
import type { IssuesResponse } from '@/experiments/console/skills/issues';
import type { CodeMapResponse } from '@/experiments/console/skills/codeMap';
import type { HostDeploy } from '@/experiments/console/skills/deploy';

/** The wire rows, named by the normalizer that consumes each one. */
export type RawCodebase = Parameters<typeof toProject>[0];
export type RawConversation = Parameters<typeof toConversationSummary>[0];
export type RawMessage = Parameters<typeof toMessage>[0];

export const AUTH_STATUS: components['schemas']['AuthStatusResponse'] = {
  enabled: false,
  signup: 'disabled',
};

export const PROJECT_ID = 'proj-console-e2e';
export const PROJECT_NAME = 'rajababa-io/console-e2e';
/** The part of `owner/repo` the rail draws as the row's label. */
export const PROJECT_SHORT_NAME = 'console-e2e';

/** The platform conversation id — the id every conversation route takes. */
export const CHAT_ID = 'web-1758900000000-e2e';
export const CHAT_DB_ID = '00000000-0000-4000-8000-000000000001';
export const CHAT_TITLE = 'Ask card renders as cards';

/** A second chat, so "the rail lists chats" is about a list and not one row. */
export const OTHER_CHAT_ID = 'web-1758900000001-e2e';
export const OTHER_CHAT_TITLE = 'Second chat in the rail';

export const PROJECT: RawCodebase = {
  id: PROJECT_ID,
  name: PROJECT_NAME,
  default_cwd: '/home/appuser/console-e2e',
  default_branch: 'dev',
  repository_url: 'https://github.com/rajababa-io/console-e2e',
  kind: 'repo',
  created_at: '2026-09-26T10:00:00.000Z',
  updated_at: '2026-09-26T10:00:00.000Z',
};

function chatRow(
  platformId: string,
  dbId: string,
  title: string,
  lastActivityAt: string,
  lastReadAt: string = lastActivityAt
): RawConversation {
  return {
    id: dbId,
    platform_conversation_id: platformId,
    platform_type: 'web',
    title,
    last_activity_at: lastActivityAt,
    color: null,
    ai_assistant_type: 'claude',
    completed_at: null,
    sort_order: null,
    ask_candidate: null,
    last_read_at: lastReadAt,
    ready_at: null,
  };
}

export const CHATS: RawConversation[] = [
  chatRow(CHAT_ID, CHAT_DB_ID, CHAT_TITLE, '2026-09-26T11:00:00.000Z'),
  // Unread — it moved after it was last read. Both chats are idle, so the
  // switcher's unread-first tiebreak is what puts this older chat on top.
  chatRow(
    OTHER_CHAT_ID,
    '00000000-0000-4000-8000-000000000002',
    OTHER_CHAT_TITLE,
    '2026-09-26T10:30:00.000Z',
    '2026-09-26T10:00:00.000Z'
  ),
];

/** Prose the transcript test looks for, unique enough that nothing else matches. */
export const USER_TURN_TEXT = 'Show me the options for the rail width.';
export const ASSISTANT_PROSE = 'Rail width — three ways to decide it.';

/** The ask block's question and its first option, as the card must render them. */
export const ASK_QUESTION = 'How should the rail decide its width?';
export const ASK_OPTION_LABEL = 'Remember the last drag';
export const ASK_OPTION_DETAIL = 'Persisted per browser, so two machines can disagree.';
export const ASK_SECOND_OPTION_LABEL = 'Fixed 280px';

/**
 * The agent's reply: prose, then a fenced ```ask block.
 *
 * Written as the agent writes it — a fence holding JSON — because the fence is
 * the contract the console parses. Building an `AskSpec` object here and
 * serializing it would test the serializer, not the thing that ships.
 */
export const ASSISTANT_REPLY = [
  ASSISTANT_PROSE,
  '',
  '```ask',
  JSON.stringify(
    {
      questions: [
        {
          title: ASK_QUESTION,
          options: [
            {
              label: ASK_OPTION_LABEL,
              detail: ASK_OPTION_DETAIL,
              recommended: true,
              why: 'It is what a reader expects a dragged edge to do.',
            },
            { label: ASK_SECOND_OPTION_LABEL },
          ],
        },
      ],
    },
    null,
    2
  ),
  '```',
].join('\n');

export const MESSAGES: RawMessage[] = [
  {
    id: 'msg-1',
    role: 'user',
    content: USER_TURN_TEXT,
    metadata: '{}',
    created_at: '2026-09-26T10:58:00.000Z',
  },
  {
    id: 'msg-2',
    role: 'assistant',
    content: ASSISTANT_REPLY,
    metadata: '{}',
    created_at: '2026-09-26T11:00:00.000Z',
  },
];

/** The second chat has its own transcript, so opening a chat is observable. */
export const OTHER_CHAT_TEXT = 'Nothing to see in this one.';

/**
 * Two images the agent drew, for the image viewer. Files the build already
 * ships, so the stub serves them as the real server serves any static asset.
 */
export const IMAGES = [
  { src: '/favicon.png', alt: 'First diagram' },
  { src: '/m/icons/icon-192.png', alt: 'Second diagram' },
] as const;

export const OTHER_MESSAGES: RawMessage[] = [
  {
    id: 'msg-o0',
    role: 'assistant',
    content: IMAGES.map(image => `![${image.alt}](${image.src})`).join('\n\n'),
    metadata: '{}',
    created_at: '2026-09-26T10:20:00.000Z',
  },
  {
    id: 'msg-o1',
    role: 'user',
    content: OTHER_CHAT_TEXT,
    metadata: '{}',
    created_at: '2026-09-26T10:30:00.000Z',
  },
];

export const CONVERSATION_COUNTS = { open: CHATS.length, done: 0, all: CHATS.length };

/** A path the Changes panel lists and whose diff it shows. */
export const CHANGED_FILE = 'src/greeting.ts';
/** A line only the diff contains, so seeing it proves the diff rendered. */
export const CHANGED_LINE = "export const greeting = 'hello, console';";

/** The uncommitted changes in the chat's checkout, as the server lists them. */
export const CHANGES: components['schemas']['ConversationChangesResponse'] = {
  state: 'ok',
  root: '/home/appuser/console-e2e',
  branch: 'feature/greeting',
  head: '0123456789abcdef0123456789abcdef01234567',
  files: [
    { path: CHANGED_FILE, oldPath: null, status: 'modified', additions: 2, deletions: 1 },
    { path: 'README.md', oldPath: null, status: 'untracked', additions: 3, deletions: 0 },
  ],
  omitted: 0,
};

export const CHANGE_DIFF: components['schemas']['ConversationChangeDiffResponse'] = {
  path: CHANGED_FILE,
  patch: [
    `diff --git a/${CHANGED_FILE} b/${CHANGED_FILE}`,
    'index 1111111..2222222 100644',
    `--- a/${CHANGED_FILE}`,
    `+++ b/${CHANGED_FILE}`,
    '@@ -1,2 +1,3 @@',
    "-export const greeting = 'hello';",
    `+${CHANGED_LINE}`,
    '+export const farewell = "bye";',
    ' export default greeting;',
    '',
  ].join('\n'),
  binary: false,
  truncated: false,
};

export type RawRun = Parameters<typeof toRun>[0];
export type RawRunEvent = Parameters<typeof toRunEvent>[0];

/** A run stopped on an approval gate, launched from no chat, so no chat's status moves. */
export const RUN_ID = 'run-e2e-0001';
export const RUN_WORKFLOW = 'deliver-e2e';
export const GATE_MESSAGE = 'Ship the rail width change?';
/** The step before the gate, which the timeline draws with its duration. */
export const RUN_FIRST_STEP = 'plan';
/** A line only that step's output holds, so opening the step proves it shows the step. */
export const RUN_STEP_OUTPUT = 'Plan written: three widths, one default.';
export const RUN_ARTIFACT = 'report.md';

/** The run as the runs feed and the run detail send it, paused on its gate or resolved. */
export function runRow(state: 'paused' | 'completed'): RawRun {
  return {
    id: RUN_ID,
    workflow_name: RUN_WORKFLOW,
    codebase_id: PROJECT_ID,
    codebase_name: PROJECT_NAME,
    conversation_id: null,
    parent_conversation_id: null,
    parent_platform_id: null,
    status: state,
    started_at: '2026-09-26T10:40:00.000Z',
    completed_at: state === 'completed' ? '2026-09-26T10:50:00.000Z' : null,
    user_message: 'Change the rail width',
    platform_type: 'cli',
    metadata:
      state === 'paused'
        ? {
            approval: {
              nodeId: 'gate',
              message: GATE_MESSAGE,
              decisions: [{ id: 'approve' }, { id: 'reject' }],
            },
          }
        : {},
  };
}

export const RUN_EVENTS: RawRunEvent[] = [
  {
    id: 'ev-1',
    workflow_run_id: RUN_ID,
    event_type: 'node_started',
    step_index: 0,
    step_name: RUN_FIRST_STEP,
    data: { name: RUN_FIRST_STEP },
    created_at: '2026-09-26T10:40:01.000Z',
  },
  {
    id: 'ev-2',
    workflow_run_id: RUN_ID,
    event_type: 'node_completed',
    step_index: 0,
    step_name: RUN_FIRST_STEP,
    data: { name: RUN_FIRST_STEP, duration_ms: 95_000, node_output: RUN_STEP_OUTPUT },
    created_at: '2026-09-26T10:41:36.000Z',
  },
  {
    id: 'ev-3',
    workflow_run_id: RUN_ID,
    event_type: 'node_started',
    step_index: 1,
    step_name: 'gate',
    data: { name: 'gate' },
    created_at: '2026-09-26T10:41:37.000Z',
  },
];

export const ARTIFACTS: components['schemas']['ListArtifactsResponse'] = {
  files: [{ path: RUN_ARTIFACT, size: 42, modifiedAt: '2026-09-26T10:41:36.000Z' }],
};
export const ARTIFACT_TEXT = '# Report\n\nThe rail keeps its last width.';

/** The project checkout the Files tab lists: one folder, one README. */
export const README_HEADING = 'Console e2e fixture';
export const README_TEXT = `# ${README_HEADING}\n\nA project the browser suite reads.`;
export const ROOT_LISTING = {
  path: '',
  entries: [
    { name: 'README.md', kind: 'file', size: README_TEXT.length },
    { name: 'src', kind: 'dir', size: null },
  ],
};

/** Issues across two board columns, so the column filter has something to change. */
export const OPEN_ISSUE_TITLE = 'Rail width forgets the last drag';
export const CLOSED_ISSUE_TITLE = 'Rail flickers on load';
export const ISSUES: IssuesResponse = {
  repo: PROJECT_NAME,
  reason: null,
  issues: [
    {
      number: 7,
      title: OPEN_ISSUE_TITLE,
      state: 'OPEN',
      stateReason: null,
      url: 'https://github.com/rajababa-io/console-e2e/issues/7',
      updatedAt: '2026-09-26T09:00:00.000Z',
      type: 'Bug',
      labels: [],
      assignees: [],
      openPr: false,
    },
    {
      number: 5,
      title: CLOSED_ISSUE_TITLE,
      state: 'CLOSED',
      stateReason: 'COMPLETED',
      url: 'https://github.com/rajababa-io/console-e2e/issues/5',
      updatedAt: '2026-09-25T09:00:00.000Z',
      type: 'Bug',
      labels: [],
      assignees: [],
      openPr: false,
    },
  ],
};

/** One pull request in CI, for the Overview's live code map. */
export const CODE_MAP_PR_TITLE = 'Rail width remembers the last drag';
export const CODE_MAP: CodeMapResponse = {
  base: 'dev',
  open: [
    {
      number: 9,
      title: CODE_MAP_PR_TITLE,
      url: 'https://github.com/rajababa-io/console-e2e/pull/9',
      branch: 'fix/rail-width',
      draft: false,
      updatedAt: '2026-09-26T09:00:00.000Z',
      checks: { state: 'running', total: 7, done: 4, failedName: null },
    },
  ],
  merged: [],
  branches: [],
  repo: PROJECT_NAME,
  reason: null,
};

/** The merged commit waiting to go live. */
export const DEPLOY_TIP = '86b91ff0aa11bb22cc33dd44ee55ff6677889900';

/** This install deploying itself, idle, with one merged PR waiting behind Deploy now. */
export const projectDeploy = {
  method: 'archon-host',
  deployOnMerge: false,
  branch: 'deploy',
  live: { sha: 'a6dd05e0c1f2a3b4c5d6e7f8091a2b3c4d5e6f70', deployedAt: '2026-09-26T07:00:00.000Z' },
  waiting: {
    tipSha: DEPLOY_TIP,
    prs: [
      {
        number: 12,
        title: 'Rail width',
        url: 'https://github.com/rajababa-io/console-e2e/pull/12',
      },
    ],
    more: false,
  },
  waitingReason: null,
  cancellable: false,
  canAct: true,
  status: { phase: 'idle' },
  running: { chats: 0, workflows: 0 },
} satisfies HostDeploy;
