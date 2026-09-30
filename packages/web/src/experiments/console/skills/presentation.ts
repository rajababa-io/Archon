/**
 * A project's presentation: icon, color, rail position, brief.
 *
 * Server-backed, with localStorage as a synchronous cache in front of it.
 *
 * The cache is not an optimisation, it is what lets the rail render its icons
 * on the first frame. A rail that fetches before it can draw a glyph shows six
 * grey placeholders and then pops — and the icon is the thing that tells the
 * rows apart, so that pop is the whole rail rearranging itself in front of you.
 */
import { requestJson } from '../lib/http';

export interface ProjectPresentation {
  color?: string | null;
  glyph?: string | null;
  /** The operator's rename; null clears it. Absent means never synced (#305). */
  displayName?: string | null;
  brief?: { why?: string; doing?: string; where?: string; updatedAt?: number | null } | null;
}

export interface PresentationResponse {
  presentation: ProjectPresentation | null;
  sortOrder: number | null;
}

const CACHE = 'archon.console.presentationCache';

function readCache(): Record<string, PresentationResponse> {
  try {
    const raw = localStorage.getItem(CACHE);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, PresentationResponse>)
      : {};
  } catch {
    return {};
  }
}

function writeCache(next: Record<string, PresentationResponse>): void {
  try {
    localStorage.setItem(CACHE, JSON.stringify(next));
  } catch {
    /* quota or private mode — the server is still the source of truth */
  }
}

/** Synchronous, for the first paint. Empty until the fetch lands. */
export function cachedPresentation(projectId: string): PresentationResponse {
  return readCache()[projectId] ?? { presentation: null, sortOrder: null };
}

export async function getPresentation(projectId: string): Promise<PresentationResponse> {
  const res = await requestJson<PresentationResponse>(
    `/api/projects/${encodeURIComponent(projectId)}/presentation`
  );
  const cache = readCache();
  cache[projectId] = res;
  writeCache(cache);
  return res;
}

/** Merges server-side; the cache is updated with whatever the server returns. */
export async function savePresentation(
  projectId: string,
  patch: { presentation?: ProjectPresentation; sortOrder?: number | null }
): Promise<PresentationResponse> {
  const res = await requestJson<PresentationResponse>(
    `/api/projects/${encodeURIComponent(projectId)}/presentation`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }
  );
  const cache = readCache();
  cache[projectId] = res;
  writeCache(cache);
  return res;
}
