import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { CodeMap } from './CodeMap';
import type { CodeMapChange, CodeMapEnvironment } from './model';

function change(key: string, state: CodeMapChange['state'], number: number): CodeMapChange {
  return {
    key,
    number,
    title: `Change ${String(number)}`,
    url: `https://github.com/o/r/pull/${String(number)}`,
    branch: 'b',
    state,
    checks: state === 'ci-running' ? { done: 4, total: 7 } : null,
    failedName: state === 'ci-failed' ? 'lint' : null,
    draft: false,
    commits: null,
    mergedAt: null,
  };
}

const ENV: CodeMapEnvironment = {
  id: 'deploy',
  label: 'deploy',
  sha: 'c01b85a1c01b85a1c01b85a1c01b85a1c01b85a1',
  since: null,
  behind: 1,
  behindMore: false,
  lastFailure: null,
};

describe('CodeMap', () => {
  const changes = [
    change('pr:343', 'merged', 343),
    change('pr:345', 'ci-running', 345),
    change('pr:347', 'ci-failed', 347),
  ];

  test('one line per change, coloured from the status tokens', () => {
    const html = renderToStaticMarkup(
      <CodeMap base="dev" changes={changes} environments={[ENV]} />
    );
    expect(html.match(/class="code-map-lane"/g)?.length).toBe(3);
    expect(html).toContain('stroke="var(--status-ready)"');
    expect(html).toContain('stroke="var(--status-waiting)"');
    expect(html).toContain('stroke="var(--error)"');
  });

  test('the deploy line names the running commit and how far behind it is', () => {
    const html = renderToStaticMarkup(
      <CodeMap base="dev" changes={changes} environments={[ENV]} />
    );
    expect(html).toContain('c01b85a1');
    expect(html).toContain('1 behind');
  });

  test('a line that just merged draws its join into the trunk', () => {
    const html = renderToStaticMarkup(
      <CodeMap base="dev" changes={changes} environments={[]} merging={new Set(['pr:343'])} />
    );
    expect(html).toContain('code-map-draw');
    expect(html).toContain('code-map-pop');
  });

  test('an environment action renders where the caller asks', () => {
    const html = renderToStaticMarkup(
      <CodeMap
        base="dev"
        changes={[]}
        environments={[ENV]}
        renderEnvironmentAction={env => <button type="button">Deploy {env.behind}</button>}
      />
    );
    expect(html).toContain('<button type="button">Deploy 1</button>');
  });
});
