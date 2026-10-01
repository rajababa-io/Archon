/**
 * How the Overview's Artifacts band reads one indexed document (#351): which
 * filter selects it, where it came from, and the colour of its source's dot.
 *
 * The type is the server's — read off the path a workflow wrote, never off the
 * contents. This file only decides how it is shown.
 */
import type { ProjectArtifact, ProjectArtifactType } from '../skills/artifacts';
import { shortRunId } from '../lib/format';

/** The filter chips, in the order the band shows them. `other` has no chip. */
export const ARTIFACT_FILTERS: readonly { type: ProjectArtifactType; label: string }[] = [
  { type: 'plan', label: 'Plans' },
  { type: 'investigation', label: 'Investigations' },
  { type: 'review', label: 'Reviews' },
  { type: 'handoff', label: 'Handoffs' },
  { type: 'data', label: 'Data' },
];

/** No chip selected means every document; otherwise any selected type. */
export function filterArtifacts(
  artifacts: readonly ProjectArtifact[],
  selected: ReadonlySet<ProjectArtifactType>
): ProjectArtifact[] {
  if (selected.size === 0) return [...artifacts];
  return artifacts.filter(a => selected.has(a.type));
}

/**
 * Where a document came from, most specific first: the PR its run opened, the
 * chat that started it, the run itself.
 */
export type ArtifactSource =
  | { kind: 'pr'; label: string; url: string }
  | { kind: 'chat'; label: string; chatId: string; done: boolean }
  | { kind: 'run'; label: string; runId: string }
  | { kind: 'none'; label: string };

export function artifactSource(a: ProjectArtifact): ArtifactSource {
  if (a.run?.prNumber != null && a.run.prUrl !== null) {
    return { kind: 'pr', label: `PR ${String(a.run.prNumber)}`, url: a.run.prUrl };
  }
  if (a.chat !== null) {
    return {
      kind: 'chat',
      label: a.chat.title ?? 'Untitled chat',
      chatId: a.chat.id,
      done: a.chat.done,
    };
  }
  if (a.run !== null) return { kind: 'run', label: `run ${shortRunId(a.run.id)}`, runId: a.run.id };
  return { kind: 'none', label: '' };
}

/**
 * The dot beside a document: the state of what produced it, in the console's
 * `--status-*` vocabulary. A run still moving says so; a failed one is red;
 * otherwise the chat's own stored marks speak — the agent saying the work
 * landed, or a human closing it.
 */
export function artifactDot(a: ProjectArtifact): { color: string; title: string } {
  const status = a.run?.status;
  if (status === 'running') return { color: 'var(--status-working)', title: 'Run going' };
  if (status === 'paused') return { color: 'var(--status-awaiting)', title: 'Run waiting for you' };
  if (status === 'failed') return { color: 'var(--error)', title: 'Run failed' };
  if (a.chat?.done === true) return { color: 'var(--status-done)', title: 'Chat closed' };
  if (a.chat?.ready === true)
    return { color: 'var(--status-ready)', title: 'Landed, ready to close' };
  return { color: 'var(--status-idle)', title: 'Nothing pending' };
}
