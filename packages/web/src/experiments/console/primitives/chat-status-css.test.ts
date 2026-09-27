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
 * It asserts a rule EXISTS, not which colour it sets. The two surfaces
 * legitimately differ: `is-awaiting` and `is-unread` use `--warning-mark` where
 * `STATUS_COLOR` uses `--warning`, because a dot is a graphic and owes 3:1 while
 * the text owes 4.5:1. Pinning them equal would force one of those to be wrong.
 *
 * `is-ready` shares `--success` with `is-done` on purpose and separates itself by
 * GEOMETRY — hollow where done is filled — so a rule that sets only a colour is
 * exactly what these assertions should find. The fill lives on the `i`, which
 * this test deliberately does not reach into: it is checking that no state
 * inherits the row, not policing how a state looks.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATUS_COLOR } from './chat-status';

const RAIL_CSS = readFileSync(join(import.meta.dir, '..', 'rail.css'), 'utf8');

describe('the rail mark covers every status', () => {
  const statuses = Object.keys(STATUS_COLOR);

  test('the statuses under test are the ones that exist, not a copied list', () => {
    // Guards the derivation itself: an empty or truncated read would make every
    // assertion below vacuously pass.
    expect(statuses).toEqual([
      'working',
      'awaiting',
      'unread',
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
    const rule = RAIL_CSS.split(`.chat-status.is-${status} {`)[1]?.split('}')[0] ?? '';
    expect(rule).toMatch(/color:\s*var\(--/);
  });
});
