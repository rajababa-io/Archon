import { describe, expect, test } from 'bun:test';
import { buildWatchCiTool, type WatchCiRequest } from './watch-ci-tool';

const SHA = 'a'.repeat(40);

function harness(open?: (request: WatchCiRequest) => Promise<{ created: boolean }>): {
  tool: ReturnType<typeof buildWatchCiTool>;
  calls: WatchCiRequest[];
} {
  const calls: WatchCiRequest[] = [];
  const tool = buildWatchCiTool({
    conversationId: 'conv-1',
    open:
      open ??
      (async (request): Promise<{ created: boolean }> => {
        calls.push(request);
        return { created: true };
      }),
  });
  return { tool, calls };
}

describe('watch_ci', () => {
  test('opens a watch on the named commit', async () => {
    const { tool, calls } = harness();
    const out = await tool.handler({ repo: 'rajababa-io/Archon', sha: SHA, pull_request: '42' });
    expect(calls).toEqual([{ repo: 'rajababa-io/Archon', headSha: SHA, pullRequest: 42 }]);
    expect(out).toContain('watching rajababa-io/Archon@aaaaaaa');
  });

  test('the pull request is optional', async () => {
    const { tool, calls } = harness();
    await tool.handler({ repo: 'o/r', sha: SHA });
    expect(calls[0]?.pullRequest).toBeNull();
  });

  test('a short SHA is refused — webhooks carry the full one, so it could never match', async () => {
    const { tool, calls } = harness();
    const out = await tool.handler({ repo: 'o/r', sha: 'abc1234' });
    expect(calls).toEqual([]);
    expect(out).toContain('40-character');
  });

  test.each([['not-a-repo'], ['o/r/extra'], [42]])('repo %p is refused', async repo => {
    const { tool, calls } = harness();
    expect(await tool.handler({ repo, sha: SHA })).toContain('watch_ci error');
    expect(calls).toEqual([]);
  });

  test('a pull request that is not a positive whole number is refused', async () => {
    const { tool, calls } = harness();
    expect(await tool.handler({ repo: 'o/r', sha: SHA, pull_request: '#12' })).toContain(
      'watch_ci error'
    );
    expect(calls).toEqual([]);
  });

  test('asking twice says nothing changed', async () => {
    const { tool } = harness(async () => ({ created: false }));
    expect(await tool.handler({ repo: 'o/r', sha: SHA })).toContain('already watching');
  });

  test('it returns the failure rather than throwing', async () => {
    const { tool } = harness(() => Promise.reject(new Error('db gone')));
    expect(await tool.handler({ repo: 'o/r', sha: SHA })).toContain('db gone');
  });
});
