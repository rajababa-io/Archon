/**
 * The project's written memory — documents across its runs and handoffs,
 * newest first (#351). An index the server builds over each run's own artifact
 * directory and the handoff records; reading one goes back to where it lives.
 */
import type { components } from '@/lib/api.generated';
import { requestJson } from '../lib/http';
import { fetchArtifact } from './runs';

/** Re-exported from the generated OpenAPI types; the schema lives in the server's project-artifacts.schemas.ts. */
export type ProjectArtifact = components['schemas']['ProjectArtifact'];
export type ProjectArtifactType = components['schemas']['ProjectArtifactType'];
type ProjectArtifactsResponse = components['schemas']['ProjectArtifactsResponse'];
type HandoffDocument = components['schemas']['HandoffDocument'];

export async function listProjectArtifacts(projectId: string): Promise<ProjectArtifact[]> {
  const res = await requestJson<ProjectArtifactsResponse>(
    `/api/codebases/${encodeURIComponent(projectId)}/artifacts`
  );
  return res.artifacts;
}

/** One artifact's text, from the run directory or the handoff document it names. */
export async function fetchProjectArtifact(
  projectId: string,
  artifact: ProjectArtifact
): Promise<string> {
  if (artifact.run !== null) return fetchArtifact(artifact.run.id, artifact.run.path);
  if (artifact.handoffId !== null) {
    const doc = await requestJson<HandoffDocument>(
      `/api/codebases/${encodeURIComponent(projectId)}/handoffs/${encodeURIComponent(artifact.handoffId)}`
    );
    return doc.content;
  }
  throw new Error('This artifact names neither a run nor a handoff');
}
