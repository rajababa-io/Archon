import { describe, expect, test } from 'bun:test';
import type { ProjectArtifact } from '../skills/artifacts';
import { artifactDot, artifactSource, filterArtifacts } from './project-artifact';

const chat = { id: 'web-1', title: '#343 Ready to close', done: false, ready: false };

function runArtifact(
  over: Partial<NonNullable<ProjectArtifact['run']>> = {},
  a: Partial<ProjectArtifact> = {}
): ProjectArtifact {
  return {
    id: 'run:r1:plan.md',
    type: 'plan',
    name: 'plan.md',
    modifiedAt: '2026-10-01T00:00:00.000Z',
    run: {
      id: 'aaaa1111-2222',
      path: 'plan.md',
      workflowName: 'archon-deliver',
      status: 'completed',
      prNumber: null,
      prUrl: null,
      ...over,
    },
    handoffId: null,
    chat,
    ...a,
  };
}

describe('filterArtifacts', () => {
  const list = [
    runArtifact({}, { id: '1', type: 'plan' }),
    runArtifact({}, { id: '2', type: 'review' }),
    runArtifact({}, { id: '3', type: 'other' }),
  ];
  test('no chip selected shows everything, other included', () => {
    expect(filterArtifacts(list, new Set()).map(a => a.id)).toEqual(['1', '2', '3']);
  });
  test('selected chips narrow to their types', () => {
    expect(filterArtifacts(list, new Set(['plan', 'review'] as const)).map(a => a.id)).toEqual([
      '1',
      '2',
    ]);
  });
});

describe('artifactSource', () => {
  test('a PR the run opened is the most specific source', () => {
    expect(
      artifactSource(runArtifact({ prNumber: 344, prUrl: 'https://github.com/o/r/pull/344' }))
    ).toEqual({
      kind: 'pr',
      label: 'PR 344',
      url: 'https://github.com/o/r/pull/344',
    });
  });
  test('then the chat that started it', () => {
    expect(artifactSource(runArtifact())).toMatchObject({
      kind: 'chat',
      label: '#343 Ready to close',
      chatId: 'web-1',
    });
  });
  test('then the run itself', () => {
    expect(artifactSource(runArtifact({}, { chat: null }))).toEqual({
      kind: 'run',
      label: 'run aaaa1111',
      runId: 'aaaa1111-2222',
    });
  });
});

describe('artifactDot', () => {
  test('a moving run speaks for itself', () => {
    expect(artifactDot(runArtifact({ status: 'running' })).color).toBe('var(--status-working)');
    expect(artifactDot(runArtifact({ status: 'paused' })).color).toBe('var(--status-awaiting)');
    expect(artifactDot(runArtifact({ status: 'failed' })).color).toBe('var(--error)');
  });
  test("a finished run takes its chat's marks; done outranks ready", () => {
    expect(artifactDot(runArtifact({}, { chat: { ...chat, ready: true } })).color).toBe(
      'var(--status-ready)'
    );
    expect(artifactDot(runArtifact({}, { chat: { ...chat, ready: true, done: true } })).color).toBe(
      'var(--status-done)'
    );
    expect(artifactDot(runArtifact()).color).toBe('var(--status-idle)');
  });
  test('a handoff reads its chat', () => {
    const handoff = runArtifact(
      {},
      { run: null, type: 'handoff', handoffId: 'm1', chat: { ...chat, done: true } }
    );
    expect(artifactDot(handoff).color).toBe('var(--status-done)');
  });
});
