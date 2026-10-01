/**
 * The pictures route (#350): it lists the project named in the path, hands the
 * listing every other project's name so a nested project's folder is skipped,
 * and answers 404 for a project that does not exist.
 */
import { afterAll, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { OpenAPIHono } from '@hono/zod-openapi';
import { removeTempTree } from '@archon/paths/test-utils';

const CODEBASES = [
  { id: 'p-outer', name: 'owner' },
  { id: 'p-inner', name: 'owner/repo' },
];
mock.module('@archon/core/db/codebases', () => ({
  getCodebase: async (id: string) => CODEBASES.find(c => c.id === id) ?? null,
  listCodebases: async () => CODEBASES,
}));

const { registerProjectPicturesRoutes } = await import('./project-pictures');

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.splice(0).map(removeTempTree));
});

async function app(): Promise<OpenAPIHono> {
  const root = await mkdtemp(join(tmpdir(), 'pictures-route-'));
  roots.push(root);
  for (const path of ['owner/topic/outer.png', 'owner/repo/topic/inner.png']) {
    const full = join(root, ...path.split('/'));
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, 'x');
  }
  const a = new OpenAPIHono();
  registerProjectPicturesRoutes(a, {
    publicRoot: root,
    makeThumbnail: async (_source, target) => {
      await writeFile(target, 't');
    },
  });
  return a;
}

describe('GET /api/projects/:projectId/pictures', () => {
  test("lists the project's own pictures and none of a nested project's", async () => {
    const res = await (await app()).request('/api/projects/p-outer/pictures');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { all: number; pictures: { url: string }[] };
    expect(body.all).toBe(1);
    expect(body.pictures.map(p => p.url)).toEqual(['/files/owner/topic/outer.png']);
  });

  test('the nested project sees only its own', async () => {
    const res = await (await app()).request('/api/projects/p-inner/pictures?limit=8&offset=0');
    const body = (await res.json()) as { pictures: { url: string }[] };
    expect(body.pictures.map(p => p.url)).toEqual(['/files/owner/repo/topic/inner.png']);
  });

  test('an unknown project is a 404', async () => {
    const res = await (await app()).request('/api/projects/nope/pictures');
    expect(res.status).toBe(404);
  });

  test('a limit outside 1..200 is refused', async () => {
    const res = await (await app()).request('/api/projects/p-outer/pictures?limit=0');
    expect(res.status).toBe(400);
  });
});
