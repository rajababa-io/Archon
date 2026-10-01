/**
 * The project's written memory, newest first (#351).
 *
 *   GET /api/codebases/{id}/artifacts                 documents across runs + handoffs
 *   GET /api/codebases/{id}/handoffs/{handoffId}      one handoff document's text
 *
 * An INDEX over storage that already exists, not a copy of it. Run artifacts
 * are listed by the same reader as a run's own Artifacts tab and read back
 * through `GET /api/artifacts/{runId}/{path}`; handoffs are found through the
 * lineage the relay records on a successor chat's seed message.
 *
 * Cost per page load is bounded twice. Only the newest `RUN_WINDOW` runs are
 * considered, and a run that has finished is listed once and then served from
 * `listingCache` until its row changes — so a steady page load walks only the
 * directories of runs that are still moving.
 */
import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import * as codebaseDb from '@archon/core/db/codebases';
import * as artifactDb from '@archon/core/db/project-artifacts';
import type { ArtifactRunRow } from '@archon/core/db/project-artifacts';
import { defaultHandoffsDir, readLineage } from '@archon/core/orchestrator/handoff';
import { createLogger, isInsideArchonHome, isPathInside } from '@archon/paths';
import { errorSchema } from './schemas/common.schemas';
import {
  handoffDocumentSchema,
  projectArtifactsResponseSchema,
  type projectArtifactSchema,
  type projectArtifactTypeSchema,
} from './schemas/project-artifacts.schemas';
import { listRunArtifactFiles, resolveRunArtifactDir, type RunArtifactFile } from './run-artifacts';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('project-artifacts');
  return cachedLog;
}

type ProjectArtifact = z.infer<typeof projectArtifactSchema>;
export type ArtifactType = z.infer<typeof projectArtifactTypeSchema>;

/** How many of the project's newest runs are looked at. */
export const RUN_WINDOW = 60;
/** How many of the project's newest handoffs are looked at. */
const HANDOFF_WINDOW = 50;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
/** A handoff is a page of prose; anything far past that is not one. */
const MAX_HANDOFF_BYTES = 1024 * 1024;

/** Extensions that make a file a document worth listing. Images belong to Pictures. */
const DOCUMENT_EXTENSIONS = new Set([
  'md',
  'markdown',
  'txt',
  'json',
  'jsonl',
  'yaml',
  'yml',
  'csv',
  'tsv',
]);
const DATA_EXTENSIONS = new Set(['json', 'jsonl', 'yaml', 'yml', 'csv', 'tsv']);

function splitName(path: string): { dirs: string[]; stem: string; ext: string } {
  const segments = path.split('/');
  const name = segments.pop() ?? '';
  const dot = name.lastIndexOf('.');
  return {
    dirs: segments,
    stem: (dot > 0 ? name.slice(0, dot) : name).toLowerCase(),
    ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : '',
  };
}

/**
 * Whether a run file is a document. Any dot-segment is workflow bookkeeping
 * (`.pr-number`, `.server-port`) rather than something a person reads.
 */
export function isArtifactDocument(path: string): boolean {
  if (path.split('/').some(seg => seg.startsWith('.'))) return false;
  return DOCUMENT_EXTENSIONS.has(splitName(path).ext);
}

/**
 * A run artifact's type, from the path convention the bundled workflows write
 * to: `$ARTIFACTS_DIR/plan.md`, `refactor-plan.md`, `investigation.md`, the
 * `review/` directory, `code-review-*.md`. Never from the file's contents.
 */
export function runArtifactType(path: string): Exclude<ArtifactType, 'handoff'> {
  const { dirs, stem, ext } = splitName(path);
  const top = dirs[0];
  if (top === 'review' || top === 'reviews') return 'review';
  if (stem === 'plan' || stem.endsWith('-plan')) return 'plan';
  if (stem === 'investigation') return 'investigation';
  if (stem === 'review' || stem.startsWith('code-review')) return 'review';
  if (DATA_EXTENSIONS.has(ext)) return 'data';
  return 'other';
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

interface RunListing {
  /** The run row's state when listed. A finished run's files do not move until it does. */
  stamp: string;
  documents: RunArtifactFile[];
  prNumber: number | null;
  prUrl: string | null;
}

/** Finished runs' listings. Insertion-ordered, so the oldest entry goes first. */
const listingCache = new Map<string, RunListing>();
const MAX_CACHED_RUNS = 2000;

/** For tests: forget every cached listing. */
export function resetArtifactListingCache(): void {
  listingCache.clear();
}

function stampOf(run: ArtifactRunRow): string {
  return [
    run.status,
    run.completed_at?.toISOString() ?? '',
    run.last_activity_at?.toISOString() ?? '',
  ].join('|');
}

async function readSmallText(path: string): Promise<string | null> {
  try {
    const text = await readFile(path, 'utf-8');
    return text.length > 512 ? null : text.trim();
  } catch {
    return null;
  }
}

/**
 * One run's documents plus its PR link, from cache when the run is finished
 * and unchanged. Null when the run's directory cannot be read — that run is
 * left out of this answer and asked about again on the next.
 */
async function listingFor(
  run: ArtifactRunRow,
  codebase: { kind?: string | null; name: string; default_cwd: string }
): Promise<RunListing | null> {
  const stamp = stampOf(run);
  const cached = listingCache.get(run.id);
  if (cached?.stamp === stamp) return cached;

  const dir = resolveRunArtifactDir(run, codebase, run.id);
  let listing: RunListing;
  if (dir === null || !isInsideArchonHome(dir)) {
    getLog().warn({ runId: run.id, dir }, 'project_artifacts.run_dir_unavailable');
    listing = { stamp, documents: [], prNumber: null, prUrl: null };
  } else {
    let files: RunArtifactFile[];
    try {
      files = await listRunArtifactFiles(dir);
    } catch (error) {
      getLog().warn({ err: error, runId: run.id }, 'project_artifacts.run_walk_failed');
      return null;
    }
    const has = (p: string): boolean => files.some(f => f.path === p);
    // `.pr-number` / `.pr-url` are the workflows' own record of the PR they
    // opened — a machine token in a file, not prose.
    const prText = has('.pr-number') ? await readSmallText(join(dir, '.pr-number')) : null;
    const urlText = has('.pr-url') ? await readSmallText(join(dir, '.pr-url')) : null;
    listing = {
      stamp,
      documents: files.filter(f => isArtifactDocument(f.path)),
      prNumber: prText !== null && /^\d+$/.test(prText) ? Number(prText) : null,
      prUrl: urlText?.startsWith('https://') ? urlText : null,
    };
  }

  if (TERMINAL.has(run.status)) {
    listingCache.delete(run.id);
    listingCache.set(run.id, listing);
    if (listingCache.size > MAX_CACHED_RUNS) {
      const oldest = listingCache.keys().next().value;
      if (oldest !== undefined) listingCache.delete(oldest);
    }
  }
  return listing;
}

/** The project's documents across its newest runs and handoffs, newest first. */
export async function buildProjectArtifacts(
  codebase: { id: string; kind?: string | null; name: string; default_cwd: string },
  limit: number
): Promise<ProjectArtifact[]> {
  const [runs, seeds] = await Promise.all([
    artifactDb.listArtifactRuns(codebase.id, RUN_WINDOW),
    artifactDb.listHandoffSeeds(codebase.id, HANDOFF_WINDOW),
  ]);

  const out: ProjectArtifact[] = [];
  const listings = await Promise.all(runs.map(run => listingFor(run, codebase)));
  runs.forEach((run, i) => {
    const listing = listings[i];
    if (listing === null || listing === undefined) return;
    for (const doc of listing.documents) {
      out.push({
        id: `run:${run.id}:${doc.path}`,
        type: runArtifactType(doc.path),
        name: basename(doc.path),
        modifiedAt: doc.modifiedAt,
        run: {
          id: run.id,
          path: doc.path,
          workflowName: run.workflow_name,
          status: run.status,
          prNumber: listing.prNumber,
          prUrl: listing.prUrl,
        },
        handoffId: null,
        chat: run.chat,
      });
    }
  });

  for (const seed of seeds) {
    const lineage = readLineage(seed.metadata);
    if (lineage === null) continue;
    out.push({
      id: `handoff:${seed.id}`,
      type: 'handoff',
      name: basename(lineage.document),
      modifiedAt: seed.created_at.toISOString(),
      run: null,
      handoffId: seed.id,
      chat: seed.chat,
    });
  }

  out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return out.slice(0, limit);
}

/**
 * A handoff's text, read from the path its own lineage record names — and only
 * from inside the directory the handoff tool writes to, resolved through
 * symlinks, so a record cannot be made to point the server at another file.
 */
async function readHandoffDocument(
  document: string
): Promise<{ ok: true; content: string } | { ok: false; status: 404 | 413 }> {
  let real: string;
  let root: string;
  try {
    [real, root] = await Promise.all([realpath(document), realpath(defaultHandoffsDir())]);
  } catch {
    return { ok: false, status: 404 };
  }
  if (!isPathInside(root, real) || !real.endsWith('.md')) return { ok: false, status: 404 };
  const info = await stat(real);
  if (info.size > MAX_HANDOFF_BYTES) return { ok: false, status: 413 };
  return { ok: true, content: await readFile(real, 'utf-8') };
}

const json = <T>(schema: T, description: string) =>
  ({ content: { 'application/json': { schema } }, description }) as const;

const listRoute = createRoute({
  method: 'get',
  path: '/api/codebases/{id}/artifacts',
  tags: ['Codebases'],
  summary: "The project's documents across its runs and handoffs, newest first",
  description:
    'An index over existing storage: run artifacts (plans, investigations, reviews, data) ' +
    "from the project's newest runs, plus the handoff documents its chats were opened " +
    'from. A run artifact is read with `GET /api/artifacts/{runId}/{path}`; a handoff ' +
    'with `GET /api/codebases/{id}/handoffs/{handoffId}`.',
  request: {
    params: z.object({ id: z.string() }),
    query: z.object({
      limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
    }),
  },
  responses: {
    200: json(projectArtifactsResponseSchema, 'OK'),
    404: json(errorSchema, 'Project not found'),
    500: json(errorSchema, 'Server error'),
  },
});

const handoffRoute = createRoute({
  method: 'get',
  path: '/api/codebases/{id}/handoffs/{handoffId}',
  tags: ['Codebases'],
  summary: "One of the project's handoff documents",
  request: { params: z.object({ id: z.string(), handoffId: z.string() }) },
  responses: {
    200: json(handoffDocumentSchema, 'OK'),
    404: json(errorSchema, 'No such handoff in this project, or its document is gone'),
    413: json(errorSchema, 'Document too large to preview'),
    500: json(errorSchema, 'Server error'),
  },
});

export function registerProjectArtifactRoutes(app: OpenAPIHono): void {
  app.openapi(listRoute, async c => {
    const { id } = c.req.valid('param');
    const { limit } = c.req.valid('query');
    try {
      const codebase = await codebaseDb.getCodebase(id);
      if (!codebase) return c.json({ error: 'Project not found' }, 404);
      const artifacts = await buildProjectArtifacts(codebase, limit ?? DEFAULT_LIMIT);
      return c.json({ artifacts }, 200);
    } catch (error) {
      getLog().error({ err: error, codebaseId: id }, 'project_artifacts.list_failed');
      return c.json({ error: 'Failed to list artifacts' }, 500);
    }
  });

  app.openapi(handoffRoute, async c => {
    const { id, handoffId } = c.req.valid('param');
    try {
      const seed = await artifactDb.getHandoffSeed(id, handoffId);
      const lineage = seed === null ? null : readLineage(seed.metadata);
      if (lineage === null) return c.json({ error: 'Handoff not found' }, 404);
      const read = await readHandoffDocument(lineage.document);
      if (!read.ok) {
        return read.status === 413
          ? c.json({ error: 'Handoff document is too large to preview' }, 413)
          : c.json({ error: 'Handoff document is no longer on disk' }, 404);
      }
      return c.json({ name: basename(lineage.document), content: read.content }, 200);
    } catch (error) {
      getLog().error({ err: error, codebaseId: id, handoffId }, 'project_artifacts.handoff_failed');
      return c.json({ error: 'Failed to read handoff' }, 500);
    }
  });
}
