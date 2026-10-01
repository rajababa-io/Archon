/**
 * The project artifact index (#351). What matters: types come from the path a
 * workflow wrote to; bookkeeping files and images stay out; a finished run is
 * walked once and then served from the cache, while a running one is walked
 * every time; handoffs come from their lineage record and are read only from
 * inside the handoff directory.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArtifactRunRow, HandoffSeedRow } from '@archon/core/db/project-artifacts';
import { removeTempTree } from '@archon/paths/test-utils';

let home = '';
let handoffsDir = '';
let runs: ArtifactRunRow[] = [];
let seeds: HandoffSeedRow[] = [];

mock.module('@archon/core/db/project-artifacts', () => ({
  listArtifactRuns: async () => runs,
  listHandoffSeeds: async () => seeds,
  getHandoffSeed: async (_codebaseId: string, id: string) => seeds.find(s => s.id === id) ?? null,
}));
mock.module('@archon/core/db/codebases', () => ({
  getCodebase: async (id: string) =>
    id === 'cb1' ? { id: 'cb1', kind: 'repo', name: 'o/r', default_cwd: '/nowhere' } : null,
}));
const realHandoff = await import('@archon/core/orchestrator/handoff');
mock.module('@archon/core/orchestrator/handoff', () => ({
  ...realHandoff,
  defaultHandoffsDir: () => handoffsDir,
}));

const {
  buildProjectArtifacts,
  isArtifactDocument,
  registerProjectArtifactRoutes,
  resetArtifactListingCache,
  runArtifactType,
} = await import('./project-artifacts');

const savedHome = process.env.ARCHON_HOME;
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'archon-artifacts-'));
  process.env.ARCHON_HOME = home;
  handoffsDir = join(home, 'handoffs');
  await mkdir(handoffsDir, { recursive: true });
});
afterAll(async () => {
  if (savedHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = savedHome;
  await removeTempTree(home);
});
beforeEach(() => {
  resetArtifactListingCache();
  runs = [];
  seeds = [];
});

const CODEBASE = { id: 'cb1', kind: 'repo', name: 'o/r', default_cwd: '/nowhere' };
const chat = { id: 'web-1', title: '#343 Ready to close', done: false, ready: true };

function runRow(id: string, status: ArtifactRunRow['status']): ArtifactRunRow {
  return {
    id,
    workflow_name: 'archon-deliver',
    status,
    output_root: join(home, 'proj'),
    started_at: new Date('2026-09-30T10:00:00Z'),
    completed_at: status === 'running' ? null : new Date('2026-09-30T11:00:00Z'),
    last_activity_at: new Date('2026-09-30T11:00:00Z'),
    chat,
  };
}

async function writeRunFile(runId: string, path: string, text: string): Promise<void> {
  const full = join(home, 'proj', 'artifacts', 'runs', runId, path);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, text);
}

describe('runArtifactType', () => {
  test('reads the type off the path convention', () => {
    expect(runArtifactType('plan.md')).toBe('plan');
    expect(runArtifactType('refactor-plan.md')).toBe('plan');
    expect(runArtifactType('investigation.md')).toBe('investigation');
    expect(runArtifactType('review/report.md')).toBe('review');
    expect(runArtifactType('review/scope.json')).toBe('review');
    expect(runArtifactType('code-review-main.md')).toBe('review');
    expect(runArtifactType('validation.json')).toBe('data');
    expect(runArtifactType('triage.md')).toBe('other');
    // A plan-ish word is not a plan: only the convention's names count.
    expect(runArtifactType('plan-context.md')).toBe('other');
  });

  test('lists documents, not bookkeeping or pictures', () => {
    expect(isArtifactDocument('plan.md')).toBe(true);
    expect(isArtifactDocument('state.json')).toBe(true);
    expect(isArtifactDocument('.pr-number')).toBe(false);
    expect(isArtifactDocument('.cache/plan.md')).toBe(false);
    expect(isArtifactDocument('shot.png')).toBe(false);
  });
});

describe('buildProjectArtifacts', () => {
  test('lists run documents newest first with their PR and chat', async () => {
    await writeRunFile('r1', 'plan.md', '# plan');
    await writeRunFile('r1', '.pr-number', '344\n');
    await writeRunFile('r1', '.pr-url', 'https://github.com/o/r/pull/344\n');
    await writeRunFile('r1', 'shot.png', 'x');
    runs = [runRow('r1', 'completed')];

    const out = await buildProjectArtifacts(CODEBASE, 100);
    expect(out.map(a => a.name)).toEqual(['plan.md']);
    expect(out[0]?.type).toBe('plan');
    expect(out[0]?.run).toMatchObject({ id: 'r1', path: 'plan.md', prNumber: 344 });
    expect(out[0]?.run?.prUrl).toBe('https://github.com/o/r/pull/344');
    expect(out[0]?.chat).toEqual(chat);
  });

  test('walks a finished run once, a running run every time', async () => {
    await writeRunFile('done', 'plan.md', 'a');
    await writeRunFile('live', 'investigation.md', 'b');
    runs = [runRow('done', 'completed'), runRow('live', 'running')];
    expect((await buildProjectArtifacts(CODEBASE, 100)).length).toBe(2);

    // New files in both: only the running run is looked at again.
    await writeRunFile('done', 'review/report.md', 'c');
    await writeRunFile('live', 'state.json', '{}');
    const names = (await buildProjectArtifacts(CODEBASE, 100)).map(a => a.name).sort();
    expect(names).toEqual(['investigation.md', 'plan.md', 'state.json']);

    // A finished run whose row changed (resumed, re-finished) is walked again.
    const done = runs[0];
    if (done) done.completed_at = new Date('2026-09-30T12:00:00Z');
    expect((await buildProjectArtifacts(CODEBASE, 100)).map(a => a.name)).toContain(
      'review/report.md'
    );
  });

  test('includes handoffs from their lineage record', async () => {
    seeds = [
      {
        id: 'm1',
        metadata: JSON.stringify({
          handoff: { from: 'c0', document: join(handoffsDir, '2026-09-30_bar.md') },
        }),
        created_at: new Date('2026-10-01T00:00:00Z'),
        chat,
      },
      // Malformed lineage is not a handoff.
      { id: 'm2', metadata: '{"handoff":{}}', created_at: new Date(), chat },
    ];
    const out = await buildProjectArtifacts(CODEBASE, 100);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: 'handoff',
      name: '2026-09-30_bar.md',
      handoffId: 'm1',
      run: null,
    });
  });

  test('honours the limit after sorting', async () => {
    await writeRunFile('r1', 'plan.md', 'a');
    seeds = [
      {
        id: 'm1',
        metadata: JSON.stringify({ handoff: { from: 'c0', document: join(handoffsDir, 'x.md') } }),
        created_at: new Date('2999-01-01T00:00:00Z'),
        chat,
      },
    ];
    runs = [runRow('r1', 'completed')];
    const out = await buildProjectArtifacts(CODEBASE, 1);
    expect(out.map(a => a.type)).toEqual(['handoff']);
  });
});

describe('routes', () => {
  const app = new OpenAPIHono();
  registerProjectArtifactRoutes(app);

  test('404 for an unknown project', async () => {
    expect((await app.request('/api/codebases/nope/artifacts')).status).toBe(404);
  });

  test('lists a project', async () => {
    await writeRunFile('r9', 'investigation.md', 'x');
    runs = [runRow('r9', 'failed')];
    const res = await app.request('/api/codebases/cb1/artifacts?limit=5');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { artifacts: { name: string }[] };
    expect(body.artifacts.map(a => a.name)).toEqual(['investigation.md']);
  });

  test('reads a handoff from inside the handoff directory only', async () => {
    const inside = join(handoffsDir, '2026-10-01_ctx.md');
    await writeFile(inside, '# Handoff\nStatus: active');
    const outsideDir = await mkdtemp(join(tmpdir(), 'archon-outside-'));
    const outside = join(outsideDir, 'secret.md');
    await writeFile(outside, 'no');
    const link = join(handoffsDir, 'sneaky.md');
    await rm(link, { force: true });
    await symlink(outside, link);

    const seed = (id: string, document: string): HandoffSeedRow => ({
      id,
      metadata: JSON.stringify({ handoff: { from: 'c0', document } }),
      created_at: new Date(),
      chat,
    });
    seeds = [
      seed('ok', inside),
      seed('out', outside),
      seed('link', link),
      seed('gone', join(handoffsDir, 'gone.md')),
    ];

    const ok = await app.request('/api/codebases/cb1/handoffs/ok');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      name: '2026-10-01_ctx.md',
      content: '# Handoff\nStatus: active',
    });
    expect((await app.request('/api/codebases/cb1/handoffs/out')).status).toBe(404);
    expect((await app.request('/api/codebases/cb1/handoffs/link')).status).toBe(404);
    expect((await app.request('/api/codebases/cb1/handoffs/gone')).status).toBe(404);
    expect((await app.request('/api/codebases/cb1/handoffs/missing')).status).toBe(404);
    await removeTempTree(outsideDir);
  });
});
