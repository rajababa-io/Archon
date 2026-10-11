import { stat } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';
import { defineNativeToolInputSchema, type NativeTool } from '@archon/providers/types';
import {
  createLogger,
  getArchonPublicPath,
  PICTURE_EXTENSIONS,
  projectPictureOwner,
  projectPictureRoot,
} from '@archon/paths';
import {
  getCodebase,
  getCodebasePresentation,
  listCodebases,
  updateCodebasePresentation,
} from '../db/codebases';

const log = createLogger('orchestrator.update_project_brief');

export interface ProjectBriefContext {
  /** The project (codebase) this chat is scoped to. */
  codebaseId: string;
}

/** One of the brief's pictures (#381). */
export interface BriefPicture {
  /** Path under the project's picture folder, `/`-separated. */
  path: string;
  caption: string;
}

/** The three parts and the pictures, as stored under `presentation.brief`. */
export interface Brief {
  why: string;
  doing: string;
  where: string;
  /** In display order; the first is shown large. */
  pictures: BriefPicture[];
  updatedAt: number | null;
}

/** A card of pictures is a summary, not the gallery the Pictures band already is. */
export const MAX_BRIEF_PICTURES = 8;

const EMPTY: Brief = { why: '', doing: '', where: '', pictures: [], updatedAt: null };

function isBriefPicture(v: unknown): v is BriefPicture {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  return typeof p.path === 'string' && typeof p.caption === 'string';
}

function readBrief(presentation: Record<string, unknown> | null): Brief {
  const raw = presentation?.brief;
  if (typeof raw !== 'object' || raw === null) return EMPTY;
  const b = raw as Partial<Brief>;
  return {
    why: typeof b.why === 'string' ? b.why : '',
    doing: typeof b.doing === 'string' ? b.doing : '',
    where: typeof b.where === 'string' ? b.where : '',
    // Absent on every brief written before #381, and on any an older binary
    // rewrites: no pictures, not an error.
    pictures: Array.isArray(b.pictures) ? b.pictures.filter(isBriefPicture) : [],
    updatedAt: typeof b.updatedAt === 'number' ? b.updatedAt : null,
  };
}

function samePictures(a: readonly BriefPicture[], b: readonly BriefPicture[]): boolean {
  return (
    a.length === b.length && a.every((p, i) => p.path === b[i]?.path && p.caption === b[i]?.caption)
  );
}

/** Same text and pictures, ignoring the timestamp. */
export function sameContent(a: Brief, b: Brief): boolean {
  return (
    a.why === b.why &&
    a.doing === b.doing &&
    a.where === b.where &&
    samePictures(a.pictures, b.pictures)
  );
}

export interface BriefPatch {
  why?: unknown;
  doing?: unknown;
  where?: unknown;
  /** Already checked by `resolveBriefPictures`; replaces the list whole. */
  pictures?: readonly BriefPicture[];
}

/**
 * Merge a call into the stored brief.
 *
 * Pure, and separate from the handler, because the rule worth testing has
 * nothing to do with the database: an omitted field KEEPS its value, and
 * content identical to what is stored does not move `updatedAt`. The pictures
 * are one field: a given list replaces the stored one whole, `[]` clears it.
 */
export function mergeBrief(before: Brief, patch: BriefPatch, now: number): Brief {
  const str = (v: unknown): string | null => (typeof v === 'string' ? v.trim() : null);
  const next: Brief = {
    why: str(patch.why) ?? before.why,
    doing: str(patch.doing) ?? before.doing,
    where: str(patch.where) ?? before.where,
    pictures: patch.pictures !== undefined ? [...patch.pictures] : before.pictures,
    updatedAt: before.updatedAt,
  };
  if (!sameContent(before, next)) next.updatedAt = now;
  return next;
}

export function isBlank(b: Brief): boolean {
  return b.why === '' && b.doing === '' && b.where === '' && b.pictures.length === 0;
}

/** Where a project's pictures may come from: its own folder, minus any nested project's. */
export interface PictureScope {
  publicRoot: string;
  projectName: string;
  /** Every other registered project's name. */
  otherProjectNames: readonly string[];
}

export type ResolvedPictures =
  | { ok: true; pictures: BriefPicture[] }
  | { ok: false; error: string };

/**
 * Check a call's `pictures` against the files on disk, and store each path
 * relative to the project's folder.
 *
 * All or nothing: one bad entry rejects the whole list, naming it, because a
 * card showing three of the four pictures the agent chose is a card nobody
 * asked for. A picture is this project's by the same rule the gallery uses —
 * it sits under `<public>/<project name>/` and not under a nested project's
 * folder there — so the brief can never show a picture the gallery would not.
 */
export async function resolveBriefPictures(
  raw: unknown,
  scope: PictureScope
): Promise<ResolvedPictures> {
  if (!Array.isArray(raw)) {
    return { ok: false, error: '`pictures` must be a list of { path, caption }.' };
  }
  if (raw.length > MAX_BRIEF_PICTURES) {
    return {
      ok: false,
      error: `\`pictures\` has ${String(raw.length)} entries; the most a brief shows is ${String(MAX_BRIEF_PICTURES)}.`,
    };
  }
  const root = projectPictureRoot(scope.publicRoot, scope.projectName);
  if (root === null) {
    return { ok: false, error: `project "${scope.projectName}" has no picture folder.` };
  }
  const ownerOf = projectPictureOwner(scope.publicRoot, [
    scope.projectName,
    ...scope.otherProjectNames,
  ]);

  const pictures: BriefPicture[] = [];
  for (const [i, entry] of raw.entries()) {
    const at = `pictures[${String(i)}]`;
    if (typeof entry !== 'object' || entry === null) {
      return { ok: false, error: `${at} must be an object with a path and a caption.` };
    }
    const { path, caption } = entry as Record<string, unknown>;
    if (typeof path !== 'string' || path.trim() === '') {
      return { ok: false, error: `${at} has no path.` };
    }
    const named = `${at} (${path})`;
    if (typeof caption !== 'string' || caption.trim() === '') {
      return { ok: false, error: `${named} has no caption.` };
    }
    const full = resolve(root, path.trim());
    const owner = ownerOf(full);
    if (owner === null) {
      return { ok: false, error: `${named} is outside this project's folder, ${root}.` };
    }
    if (owner !== scope.projectName) {
      return { ok: false, error: `${named} is project ${owner}'s picture, not this project's.` };
    }
    const rel = relative(root, full).split(sep);
    if (rel.some(seg => seg.startsWith('.'))) {
      return { ok: false, error: `${named} is in a hidden folder, which is never shown.` };
    }
    if (!PICTURE_EXTENSIONS.has(extname(full).toLowerCase())) {
      return {
        ok: false,
        error: `${named} is not a picture; use one of ${[...PICTURE_EXTENSIONS].join(' ')}.`,
      };
    }
    try {
      if (!(await stat(full)).isFile()) {
        return { ok: false, error: `${named} is not a file.` };
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      return { ok: false, error: `${named} does not exist.` };
    }
    const stored = rel.join('/');
    if (pictures.some(p => p.path === stored)) {
      return { ok: false, error: `${named} is listed twice.` };
    }
    pictures.push({ path: stored, caption: caption.trim() });
  }
  return { ok: true, pictures };
}

const INPUT_SCHEMA = defineNativeToolInputSchema({
  properties: {
    why: {
      kind: 'string',
      description:
        'Why this project exists. The standing answer, which rarely changes — leave it out unless it is actually wrong.',
    },
    doing: {
      kind: 'string',
      description: 'What is being worked on now. One or two sentences.',
    },
    where: {
      kind: 'string',
      description:
        'Where it has got to — what is done, what is open, what is blocked. The part that goes stale fastest.',
    },
    pictures: {
      kind: 'array',
      description: `Pictures shown at the top of the brief, in order — the first large, the rest as thumbnails. Each is { "path": ..., "caption": ... }, where path is an image already published under this project's own folder in the public directory (absolute, or relative to that folder). At most ${String(MAX_BRIEF_PICTURES)}. Replaces the whole list; [] clears it; omit to keep it.`,
    },
  },
  required: [],
});

/**
 * Lets the agent keep a PROJECT's brief current.
 *
 * Why a tool and not a nightly job that reads the repo: "where it has got to"
 * is a judgement. A model reading commits back can say what changed; only the
 * agent that did the work knows whether it mattered, or what is still open.
 *
 * Call it when a piece of work LANDS — not every turn, and not when a question
 * was merely answered. Two reasons. The brief is read by someone arriving
 * cold, so churn makes it worse, not fresher. And the card shows "written 4m
 * ago", which is the only thing that stops a stale brief being believed: if
 * every turn bumped it, the timestamp would say "fresh" about text nobody had
 * revisited.
 *
 * That is enforced, not just asked for. A call whose fields match what is
 * already stored leaves `updatedAt` alone — an agent that reflexively
 * rewrites the same words cannot make a stale brief look new.
 *
 * Fields are OMITTED to keep them, not blanked. `why` in particular usually
 * survives a rewrite of the other two.
 */
export function buildProjectBriefTool(ctx: ProjectBriefContext): NativeTool {
  return {
    name: 'update_project_brief',
    description:
      "Rewrite this project's brief — `why` it exists, what we are `doing`, `where` it has got to, and the `pictures` that explain it — so someone arriving cold can see the state of the project. Call it when a piece of work LANDS (a PR opened, a fix shipped, a direction abandoned), NOT every turn and not for a question you merely answered. Omit a field to leave it unchanged; `why` rarely needs rewriting. Write plainly, in full sentences, and say what is actually true now — including what is broken or unfinished.",
    inputSchema: INPUT_SCHEMA,
    handler: async (input): Promise<string> => {
      try {
        const current = await getCodebasePresentation(ctx.codebaseId);
        if (current === null) return 'update_project_brief: this project no longer exists.';
        const before = readBrief(current.presentation);

        let pictures: BriefPicture[] | undefined;
        if (input.pictures !== undefined) {
          const codebase = await getCodebase(ctx.codebaseId);
          if (codebase === null) return 'update_project_brief: this project no longer exists.';
          const resolved = await resolveBriefPictures(input.pictures, {
            publicRoot: getArchonPublicPath(),
            projectName: codebase.name,
            otherProjectNames: (await listCodebases())
              .filter(cb => cb.id !== codebase.id)
              .map(cb => cb.name),
          });
          if (!resolved.ok) return `update_project_brief: nothing stored — ${resolved.error}`;
          pictures = resolved.pictures;
        }

        const next = mergeBrief(
          before,
          { why: input.why, doing: input.doing, where: input.where, pictures },
          Date.now()
        );

        if (isBlank(next)) {
          return 'update_project_brief: nothing to write — give at least one of why/doing/where/pictures.';
        }
        if (sameContent(before, next)) {
          return 'update_project_brief: unchanged, so the "written" time was left alone.';
        }

        await updateCodebasePresentation(ctx.codebaseId, { brief: next });
        const changed = [
          ...(['why', 'doing', 'where'] as const).filter(k => before[k] !== next[k]),
          ...(samePictures(before.pictures, next.pictures) ? [] : ['pictures']),
        ];
        log.info({ codebaseId: ctx.codebaseId, changed }, 'project_brief.updated');
        return `update_project_brief: updated ${changed.join(', ')}.`;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log.error({ err: e, codebaseId: ctx.codebaseId }, 'project_brief.failed');
        return `update_project_brief error: ${msg}`;
      }
    },
  };
}
