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
  // Unread — it moved after it was last read — so the two chats differ in
  // status, and an order by status differs from an order by recency.
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
