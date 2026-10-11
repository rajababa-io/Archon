/** Project primitive. Canonical in-spike shape, normalized from server schema. */
export interface Project {
  id: string;
  name: string;
  path: string;
  defaultBranch: string;
  repositoryUrl: string | null;
  lastSyncedAt: string | null;
  /** 'folder' = non-git workspace running in place; 'repo' = git repository. */
  kind: 'repo' | 'folder';
  /**
   * Why the project exists, what is being worked on, and where it has got to.
   *
   * WRITTEN BY THE AGENT, never by hand. It arrives on the project row because
   * that is what it is — a property of the project, not a per-browser note —
   * which also means it is the same on every machine without anything syncing.
   *
   * `null` when nothing has been written yet, which the card says out loud
   * rather than showing a confident blank.
   */
  brief: ProjectBrief | null;
}

/** The three parts of a brief. Split so a stale `doing` cannot discredit a
 *  `why` that is still true. */
export interface ProjectBrief {
  why: string;
  doing: string;
  where: string;
  /**
   * Pictures at the top of the card, in the agent's order (#381). Empty for a
   * brief written before there were any.
   */
  pictures: BriefPicture[];
  /** Epoch ms of the last rewrite, so the card can say how fresh it is. */
  updatedAt: number | null;
}

export interface BriefPicture {
  /** Path under the project's picture folder — a gallery picture's `path`. */
  path: string;
  caption: string;
}

type RawBrief = Partial<Omit<ProjectBrief, 'pictures'>> & { pictures?: unknown };

interface RawCodebase {
  id: string;
  name: string;
  default_cwd: string;
  default_branch?: string | null;
  repository_url: string | null;
  kind?: 'repo' | 'folder';
  updated_at: string;
  created_at: string;
  /** The console's own view of the project. Rides along on the row; no
   *  separate request. */
  presentation?: { brief?: RawBrief | null } | null;
}

function toBriefPictures(raw: unknown): BriefPicture[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((p: unknown): BriefPicture[] => {
    if (typeof p !== 'object' || p === null) return [];
    const { path, caption } = p as Record<string, unknown>;
    return typeof path === 'string' && typeof caption === 'string' ? [{ path, caption }] : [];
  });
}

/** A brief is worth showing only if it says something. Whitespace is nothing. */
function toBrief(raw: RawCodebase): ProjectBrief | null {
  const b = raw.presentation?.brief;
  if (b === undefined || b === null) return null;
  const brief: ProjectBrief = {
    why: b.why ?? '',
    doing: b.doing ?? '',
    where: b.where ?? '',
    pictures: toBriefPictures(b.pictures),
    updatedAt: b.updatedAt ?? null,
  };
  return brief.why.trim() === '' &&
    brief.doing.trim() === '' &&
    brief.where.trim() === '' &&
    brief.pictures.length === 0
    ? null
    : brief;
}

export function toProject(raw: RawCodebase): Project {
  return {
    id: raw.id,
    name: raw.name,
    path: raw.default_cwd,
    defaultBranch: raw.default_branch ?? 'main',
    repositoryUrl: raw.repository_url,
    lastSyncedAt: raw.updated_at,
    // Backfill to 'repo' for older payloads (pre-kind); never leaves it undefined.
    kind: raw.kind ?? 'repo',
    brief: toBrief(raw),
  };
}

/**
 * The account or org a project belongs to — the part of `owner/repo` before
 * the first slash. A bare name has no owner and groups under itself, which is
 * what a locally-added folder looks like.
 */
export function ownerOf(name: string): string {
  const i = name.indexOf('/');
  return i === -1 ? name : name.slice(0, i);
}

export interface OwnerGroup<T> {
  owner: string;
  items: T[];
  /** Index of this group's first item in the flat list it came from. */
  start: number;
}

/**
 * Group a list by owner WITHOUT reordering it.
 *
 * Each group appears where its first project already sat, and items keep their
 * relative order inside it. That matters because the list handed in is the
 * user's hand-arranged order: sorting the groups alphabetically would silently
 * rearrange a rail somebody dragged into shape.
 *
 * A project whose owner already has a group joins it even if other owners
 * appear in between, so the groups are contiguous in the output even when they
 * were interleaved in the input.
 */
export function groupByOwner<T extends { name: string }>(items: readonly T[]): OwnerGroup<T>[] {
  const out: OwnerGroup<T>[] = [];
  const index = new Map<string, OwnerGroup<T>>();
  for (const item of items) {
    const owner = ownerOf(item.name);
    let g = index.get(owner);
    if (g === undefined) {
      g = { owner, items: [], start: 0 };
      index.set(owner, g);
      out.push(g);
    }
    g.items.push(item);
  }
  let at = 0;
  for (const g of out) {
    g.start = at;
    at += g.items.length;
  }
  return out;
}

/**
 * The displayed order with one account's whole section moved up or down.
 *
 * Grouping does not sort (see `groupByOwner`): a section sits where its first
 * project sits, so moving an account means moving its projects as a BLOCK past
 * the neighbouring account's. Everything else — the projects inside each
 * section, and the sections either side — keeps its place.
 *
 * Returns the ids in their new order, or `null` when there is nothing to do:
 * an unknown account, or one already at the end it is being sent to. A caller
 * that gets `null` must not write, because writing an unchanged order still
 * costs a round trip and still repaints the rail.
 */
export function moveOwnerGroup<T extends { id: string }>(
  groups: readonly OwnerGroup<T>[],
  owner: string,
  direction: -1 | 1
): string[] | null {
  const from = groups.findIndex(g => g.owner === owner);
  if (from === -1) return null;
  const to = from + direction;
  if (to < 0 || to >= groups.length) return null;
  const next = [...groups];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next.flatMap(g => g.items.map(i => i.id));
}

/**
 * Keep a drop inside the dragged row's own owner group.
 *
 * Grouping and a hand-chosen order were called mutually exclusive when the
 * owner headers were first removed. They are — but only if a drag can land
 * anywhere. Scoped to its own section both hold: dragging arranges an owner's
 * projects, and no gesture can quietly move a project to an account it does
 * not belong to.
 *
 * Returns the index to commit. An unknown id or an out-of-range drop is passed
 * through unchanged so the caller's own "nothing to do" checks still decide.
 */
export function clampDropToGroup<T extends { id: string; name: string }>(
  groups: readonly OwnerGroup<T>[],
  dragId: string,
  dropIndex: number
): number {
  const g = groups.find(x => x.items.some(i => i.id === dragId));
  if (g === undefined) return dropIndex;
  const last = g.start + g.items.length - 1;
  return Math.min(Math.max(dropIndex, g.start), last);
}
