import type { components } from '@/lib/api.generated';
import { requestJson } from '../lib/http';

export type ProjectPicture = components['schemas']['ProjectPicture'];
export type ProjectPictureTopic = components['schemas']['ProjectPictureTopic'];
export type ProjectPictures = components['schemas']['ProjectPicturesResponse'];

/** How many pictures the Overview band shows. */
export const PICTURES_BAND_SIZE = 8;

/**
 * A project's pictures, newest first — the ones published under its own
 * `/files/<project>/` folder and no other's. `topic` keeps only one topic folder.
 */
export async function listProjectPictures(
  projectId: string,
  opts: { limit: number; offset?: number; topic?: string | null }
): Promise<ProjectPictures> {
  const q = new URLSearchParams({ limit: String(opts.limit), offset: String(opts.offset ?? 0) });
  if (opts.topic !== undefined && opts.topic !== null) q.set('topic', opts.topic);
  return requestJson<ProjectPictures>(
    `/api/projects/${encodeURIComponent(projectId)}/pictures?${q.toString()}`
  );
}
