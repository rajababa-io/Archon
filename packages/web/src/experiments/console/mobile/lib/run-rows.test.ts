import { describe, expect, test } from 'bun:test';
import { toRun, type Run } from '../../primitives/run';
import { ciWaitByRun, runRowClock } from './run-rows';

function run(id: string, startedAt: string, parent: string | null, status = 'completed'): Run {
  return toRun({
    id,
    workflow_name: 'deliver',
    codebase_id: 'p',
    status,
    started_at: startedAt,
    parent_platform_id: parent,
  });
}

describe('ciWaitByRun', () => {
  test("a chat's CI wait lands on the newest run it launched", () => {
    const runs = [
      run('old', '2026-09-28T10:00:00Z', 'chat-a'),
      run('new', '2026-09-28T11:00:00Z', 'chat-a'),
      run('other', '2026-09-28T11:30:00Z', 'chat-b'),
    ];
    const waits = ciWaitByRun(runs, { 'chat-a': 1000 });
    expect([...waits]).toEqual([['new', 1000]]);
  });

  test('a run no chat launched carries no wait', () => {
    expect(ciWaitByRun([run('cli', '2026-09-28T10:00:00Z', null)], { x: 1 }).size).toBe(0);
  });

  test('naive database timestamps compare as UTC', () => {
    const runs = [
      run('later', '2026-09-28 11:00:00', 'chat-a'),
      run('earlier', '2026-09-28T10:30:00Z', 'chat-a'),
    ];
    expect([...ciWaitByRun(runs, { 'chat-a': 5 }).keys()]).toEqual(['later']);
  });
});

describe('runRowClock', () => {
  const now = Date.parse('2026-09-28T12:00:00Z');

  test('a CI wait shows how long CI has been checking', () => {
    expect(runRowClock(run('r', '2026-09-28T10:00:00Z', 'c'), now - 125_000, now)).toBe('CI 02:05');
  });

  test('a live run shows how long it has been going', () => {
    const live = run('r', '2026-09-28T11:58:30Z', null, 'running');
    expect(runRowClock(live, undefined, now)).toBe('01:30');
  });

  test('a finished run shows when it started', () => {
    expect(runRowClock(run('r', '2026-09-28T09:00:00Z', null), undefined, now)).toBe('3h ago');
  });
});
