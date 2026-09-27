import { describe, expect, test } from 'bun:test';
import type { ConversationSummary } from '../primitives/conversation';
import type { Project } from '../primitives/project';
import type { FoundChat } from '../skills/conversations';
import { paletteResultKey, paletteResults } from './palette-results';

const project = (id: string, name: string): Project => ({
  id,
  name,
  path: `/w/${id}`,
  defaultBranch: 'dev',
  repositoryUrl: null,
  lastSyncedAt: null,
  kind: 'repo',
  brief: null,
});

const chat = (
  id: string,
  title: string | null,
  projectId: string,
  at: string,
  completed = false
): FoundChat => {
  const summary: ConversationSummary = {
    id,
    dbId: `db-${id}`,
    title,
    platformType: 'web',
    lastActivityAt: at,
    color: null,
    assistant: 'claude',
    completed,
    askCandidate: null,
    sortOrder: null,
    lastReadAt: null,
    ready: false,
  };
  return { chat: summary, projectId };
};

const projects = [project('p1', 'rajababa-io/Archon'), project('p2', 'rajababa-io/vault')];
const chats = [
  chat('c1', 'Deploy wait and log', 'p1', '2026-09-20T00:00:00Z'),
  chat('c2', 'Favicon badge', 'p2', '2026-09-26T00:00:00Z', true),
  chat('c3', null, 'p1', '2026-09-27T00:00:00Z'),
];
const keys = (q: string): string[] => paletteResults(q, projects, chats).map(paletteResultKey);

describe('paletteResults', () => {
  test('part of a chat title puts that chat first, whichever project it is in', () => {
    expect(keys('favicon')[0]).toBe('chat-c2');
    expect(keys('WAIT AND')[0]).toBe('chat-c1');
  });

  test('done chats are found alongside open ones, and keep their state', () => {
    const [first] = paletteResults('badge', projects, chats);
    expect(first?.kind === 'chat' && first.found.chat.completed).toBe(true);
  });

  test('a chat carries the name of the project it opens in', () => {
    const [first] = paletteResults('deploy', projects, chats);
    expect(first?.kind === 'chat' ? first.projectName : null).toBe('rajababa-io/Archon');
  });

  test('a project that only loosely matches ranks below every chat', () => {
    // "aa" is a subsequence of both project names and in no title.
    expect(keys('aa')).toEqual(['project-p1', 'project-p2']);
    // "an" is in one title, and only a subsequence of "rajababa-io/Archon".
    expect(keys('an')).toEqual(['chat-c1', 'project-p1']);
  });

  test('a project named by the query outright still leads', () => {
    expect(keys('vault')).toEqual(['project-p2']);
    expect(keys('archon')[0]).toBe('project-p1');
  });

  test('an untitled chat is found by the label it is shown with', () => {
    expect(keys('untitled')).toEqual(['chat-c3']);
  });

  test('an empty query lists projects, then chats newest first', () => {
    expect(keys('  ')).toEqual(['project-p1', 'project-p2', 'chat-c3', 'chat-c2', 'chat-c1']);
  });
});
