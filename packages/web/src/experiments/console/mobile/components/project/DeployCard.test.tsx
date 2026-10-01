import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { waitingPillLabel } from '../../../lib/deploy-row';
import type { DeployWaiting } from '../../../skills/deploy';
import { WaitingLine } from './DeployCard';

const waiting: DeployWaiting = {
  tipSha: 'abc1234',
  prs: [
    { number: 1, title: 'one', url: 'https://example.test/1' },
    { number: 2, title: 'two', url: 'https://example.test/2' },
  ],
  more: false,
};

describe('mobile DeployCard WaitingLine', () => {
  test('waiting merges draw the needs-you pill with the shared label', () => {
    const label = waitingPillLabel(waiting);
    const html = renderToStaticMarkup(<WaitingLine right={{ kind: 'waiting', waiting, label }} />);
    expect(html).toContain(label);
    expect(html).toContain('text-[color:var(--status-awaiting)]');
    expect(html).toContain('bg-[color:var(--status-awaiting)]/15');
    expect(html).toContain('rounded-full');
  });

  test('up to date stays neutral', () => {
    const html = renderToStaticMarkup(<WaitingLine right={{ kind: 'up-to-date' }} />);
    expect(html).toContain('Up to date');
    expect(html).not.toContain('status-awaiting');
  });

  test('unknown and Deploy on Merge stay neutral', () => {
    for (const right of [
      { kind: 'unknown', label: 'Could not read the waiting list', reason: 'x' },
      { kind: 'none' },
    ] as const) {
      const html = renderToStaticMarkup(<WaitingLine right={right} />);
      expect(html).toContain('text-text-secondary');
      expect(html).not.toContain('status-awaiting');
    }
  });
});
