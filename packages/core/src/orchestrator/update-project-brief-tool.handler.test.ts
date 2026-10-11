/**
 * The handler's own wiring: which project the chat is in, and which projects
 * are someone else's, come from the database. Its own test group, because the
 * module mock of `../db/codebases` is process-global.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import type { Codebase } from '../types';

const codebase = (id: string, name: string): Codebase => ({
  id,
  name,
  repository_url: null,
  default_cwd: `/work/${name}`,
  default_branch: 'dev',
  ai_assistant_type: 'claude',
  kind: 'repo',
  commands: {},
  created_at: new Date(0),
  updated_at: new Date(0),
});
const CODEBASES = [codebase('id-mine', 'owner/mine'), codebase('id-theirs', 'owner/theirs')];

const writes: { id: string; patch: Record<string, unknown> }[] = [];
mock.module('../db/codebases', () => ({
  getCodebase: async (id: string) => CODEBASES.find(cb => cb.id === id) ?? null,
  listCodebases: async () => CODEBASES,
  getCodebasePresentation: async (id: string) =>
    CODEBASES.some(cb => cb.id === id) ? { presentation: null, sortOrder: null } : null,
  updateCodebasePresentation: async (id: string, patch: Record<string, unknown>) => {
    writes.push({ id, patch });
  },
}));

const { buildProjectBriefTool } = await import('./update-project-brief-tool');

describe('update_project_brief handler', () => {
  let home: string;
  const savedHome = process.env.ARCHON_HOME;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'brief-handler-'));
    process.env.ARCHON_HOME = home;
    for (const f of ['public/owner/mine/a.png', 'public/owner/theirs/b.png']) {
      await mkdir(dirname(join(home, f)), { recursive: true });
      await writeFile(join(home, f), 'x');
    }
  });
  afterAll(async () => {
    if (savedHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = savedHome;
    await removeTempTree(home);
  });
  beforeEach(() => {
    writes.length = 0;
  });

  const call = (input: Record<string, unknown>): Promise<string> =>
    buildProjectBriefTool({ codebaseId: 'id-mine' }).handler(input);

  test("stores the chat's own project's picture", async () => {
    const out = await call({ pictures: [{ path: 'a.png', caption: 'A' }] });
    expect(out).toBe('update_project_brief: updated pictures.');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.id).toBe('id-mine');
    expect(writes[0]?.patch.brief).toMatchObject({ pictures: [{ path: 'a.png', caption: 'A' }] });
  });

  test("refuses another registered project's picture and stores nothing", async () => {
    const out = await call({
      doing: 'd',
      pictures: [{ path: join(home, 'public/owner/theirs/b.png'), caption: 'B' }],
    });
    expect(out).toContain('nothing stored');
    expect(out).toContain("project owner/theirs's picture");
    expect(writes).toHaveLength(0);
  });
});
