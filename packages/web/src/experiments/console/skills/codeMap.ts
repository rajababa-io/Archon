/**
 * The changes in flight on a project, for the Overview's live code map (#348):
 * open pull requests into the trunk with their CI rollup, the recently merged
 * ones, and the worktree branches a chat is coding on with no pull request yet.
 *
 * `app.get` on the server, like the issue routes, so the shape is declared
 * here (mirroring `server/src/routes/code-map.ts`) rather than generated.
 * What is LIVE is not in this answer — the map reads that from the deploy
 * answer, which owns it.
 */
import { requestJson } from '../lib/http';

export type CiState = 'none' | 'running' | 'passed' | 'failed';

export interface CodeMapPull {
  number: number;
  title: string;
  url: string;
  branch: string;
  draft: boolean;
  updatedAt: string;
  checks: { state: CiState; total: number; done: number; failedName: string | null };
}

export interface CodeMapMerged {
  number: number;
  title: string;
  url: string;
  branch: string;
  mergedAt: string;
}

export interface CodeMapBranch {
  branch: string;
  commits: number;
  lastCommitAt: string | null;
}

export interface CodeMapResponse {
  base: string | null;
  open: CodeMapPull[];
  merged: CodeMapMerged[];
  branches: CodeMapBranch[];
  repo: string | null;
  /** Why the lists are empty when the read stopped early; null when it did not. */
  reason: string | null;
}

export function getCodeMap(projectId: string): Promise<CodeMapResponse> {
  return requestJson<CodeMapResponse>(`/api/projects/${encodeURIComponent(projectId)}/code-map`);
}
