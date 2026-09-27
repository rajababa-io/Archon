import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { StatusDetailsView, checkoutLabel } from './StatusDetails';
import type { ConversationCheckout } from '../skills';

const LIVE: ConversationCheckout = {
  path: '/repos/app',
  location: 'live',
  branch: 'dev',
  dirty: false,
};

function render(
  facts: Parameters<typeof StatusDetailsView>[0]['facts'],
  checkout: ConversationCheckout | undefined
): string {
  return renderToStaticMarkup(
    <StatusDetailsView messages={[]} facts={facts} checkout={checkout} />
  );
}

describe('StatusDetails', () => {
  test('a Claude chat shows model, effort, branch and location, and cost', () => {
    const html = render({ model: 'claude-opus-5-5', effort: 'high', costUsd: 4.123 }, LIVE);
    expect(html).toContain('opus-5-5');
    expect(html).toContain('effort high');
    expect(html).toContain('⎇ dev · live checkout');
    expect(html).toContain('$4.12');
    expect(html).not.toContain('uncommitted');
  });

  test('a Codex chat with no reported cost shows no cost — never $0.00', () => {
    const html = render({ model: 'gpt-5.5', effort: 'medium', costUsd: null }, LIVE);
    expect(html).toContain('gpt-5.5');
    expect(html).toContain('effort medium');
    expect(html).not.toContain('$');
  });

  test('an effort left to the provider default is hidden, not guessed', () => {
    const html = render({ model: 'claude-opus-5-5', effort: null, costUsd: null }, LIVE);
    expect(html).not.toContain('effort');
  });

  test('a dirty checkout is marked; a worktree says so', () => {
    const html = render(null, {
      path: '/wt/x',
      location: 'worktree',
      branch: 'feat/x',
      dirty: true,
    });
    expect(html).toContain('⎇ feat/x · worktree');
    expect(html).toContain('uncommitted');
  });

  test('an unread checkout shows no branch and no marker', () => {
    const html = render(null, undefined);
    expect(html).not.toContain('⎇');
    expect(html).not.toContain('uncommitted');
  });

  test('an unknown dirty state is not a clean one, and not a dirty one either', () => {
    const html = render(null, { ...LIVE, dirty: null });
    expect(html).not.toContain('uncommitted');
    expect(html).toContain('⎇ dev');
  });
});

describe('checkoutLabel', () => {
  test('each half shows alone when only it is known, nothing when neither is', () => {
    expect(checkoutLabel({ ...LIVE, location: null })).toBe('⎇ dev');
    expect(checkoutLabel({ ...LIVE, branch: null })).toBe('live checkout');
    expect(checkoutLabel({ path: null, location: null, branch: null, dirty: null })).toBeNull();
  });
});
