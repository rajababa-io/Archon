/**
 * Every chat status must have a mark rule in `rail.css`.
 *
 * WHY THIS EXISTS. `ChatStatus` and the `.chat-status.is-*` rules are two
 * declarations that have to agree, and nothing made them. They did not: `unread`
 * shipped with a `STATUS_COLOR` entry and no CSS rule, so the WORD beside the dot
 * was amber — `ChatStatusStrip` applies `STATUS_COLOR` inline — while the dot
 * itself fell through to the row's inherited `currentColor` and rendered white.
 * A status indicator showing the wrong state is worse than showing none.
 *
 * The statuses are read from `STATUS_COLOR` rather than from a list written here.
 * That map is a `Record<ChatStatus, string>`, so the compiler already refuses an
 * incomplete one — deriving from it means a sixth status reaches this test the
 * moment it exists, instead of when somebody remembers to add it.
 *
 * Since #331 the two also have to agree on the COLOUR, and that is asserted
 * rather than hoped for: each state owns one `--status-*` token, and the rail
 * rule and `STATUS_COLOR` must both name it. They once restated the colours by
 * hand and had already drifted — the awaiting dot read `--warning-mark` while
 * its label read `--warning`. The token itself must be defined for both modes in
 * `theme/tokens.css`, or the var resolves to nothing and the dot vanishes.
 *
 * Every dot is filled. Three states used to be rings (an inset shadow on the
 * `i`) in another state's colour; the last block here keeps that from coming
 * back.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATUS_COLOR } from './chat-status';

const RAIL_CSS = readFileSync(join(import.meta.dir, '..', 'rail.css'), 'utf8');
const TOKENS_CSS = readFileSync(
  join(import.meta.dir, '..', '..', '..', 'theme', 'tokens.css'),
  'utf8'
);

/** The declarations of the first rule whose selector is exactly `selector`. */
function ruleBody(css: string, selector: string): string {
  return css.split(`${selector} {`)[1]?.split('}')[0] ?? '';
}

describe('the rail mark covers every status', () => {
  const statuses = Object.keys(STATUS_COLOR);

  test('the statuses under test are the ones that exist, not a copied list', () => {
    // Guards the derivation itself: an empty or truncated read would make every
    // assertion below vacuously pass.
    expect(statuses).toEqual([
      'working',
      'awaiting',
      'done',
      'ready',
      'running',
      'waiting',
      'idle',
    ]);
  });

  test.each(statuses)('is-%s has a rule in rail.css', status => {
    expect(RAIL_CSS).toContain(`.chat-status.is-${status} {`);
  });

  test.each(statuses)('is-%s sets a colour, so the dot never inherits the row', status => {
    // The specific failure: no `color` means `currentColor`, which is the row's
    // text — white — on every state that forgets one.
    const rule = ruleBody(RAIL_CSS, `.chat-status.is-${status}`);
    expect(rule).toMatch(/color:\s*var\(--/);
  });
});

describe('the dot and its label read one token per state (#331)', () => {
  const entries = Object.entries(STATUS_COLOR);

  test.each(entries)('%s: STATUS_COLOR names its own --status- token', (status, color) => {
    expect(color).toBe(`var(--status-${status})`);
  });

  test.each(entries)('%s: the rail rule sets the same token as STATUS_COLOR', (status, color) => {
    const rule = ruleBody(RAIL_CSS, `.chat-status.is-${status}`);
    expect(rule.match(/(?:^|;|\s)color:\s*([^;]+);/)?.[1]?.trim()).toBe(color);
  });

  test('no two states share a token', () => {
    expect(new Set(Object.values(STATUS_COLOR)).size).toBe(entries.length);
  });

  test.each(['dark', 'light'])('every token is defined in %s mode', mode => {
    const block = ruleBody(TOKENS_CSS, `[data-mode='${mode}'] .console-root`);
    for (const status of Object.keys(STATUS_COLOR)) {
      expect(block).toMatch(new RegExp(`--status-${status}:\\s*[^;]+;`));
    }
  });
});

describe('every dot is filled', () => {
  test('no state rule draws a ring', () => {
    expect(RAIL_CSS).not.toMatch(/\.chat-status\.is-\w+ i\s*\{[^}]*box-shadow/);
    expect(RAIL_CSS).not.toMatch(/\.chat-status\.is-\w+ i\s*\{[^}]*background:\s*transparent/);
  });
});

// #5: unread is the title's weight, never the dot. A leftover `.chat-status.is-unread`
// would be dead now, and a missing title rule would leave unread invisible.
describe('unread is drawn on the title, not the mark', () => {
  test('the title rule exists and sets a weight', () => {
    const rule = ruleBody(RAIL_CSS, '.rail-row.is-unread .rail-text');
    expect(rule).toMatch(/font-weight:\s*\d+/);
  });

  test('no status mark rule for unread survives', () => {
    expect(RAIL_CSS).not.toContain('.chat-status.is-unread');
  });
});
