import { describe, test, expect } from 'bun:test';
import {
  toConversationSummary,
  byArrangement,
  byMostRecent,
  colorToken,
  CONVERSATION_COLORS,
  conversationLabel,
  conversationMonogram,
  matchesFilter,
  parseConversationColor,
  resolveConversationDbId,
  UNTITLED_CHAT,
  type ConversationSummary,
} from './conversation';

const conv = (over: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id: 'web-1',
  dbId: 'db-1',
  title: 'Debug the migration',
  platformType: 'web',
  lastActivityAt: '2026-06-05T10:00:00Z',
  color: null,
  assistant: 'claude',
  completed: false,
  askCandidate: null,
  sortOrder: null,
  lastReadAt: null,
  ready: false,
  projectId: null,
  ...over,
});

describe('toConversationSummary — the ready claim', () => {
  const raw = {
    id: 'db-1',
    platform_conversation_id: 'web-1',
    platform_type: 'web',
    title: null,
    last_activity_at: null,
    color: null,
    ai_assistant_type: 'claude',
  };

  test('the timestamp IS the state', () => {
    expect(toConversationSummary({ ...raw, ready_at: '2026-06-05T10:00:00Z' }).ready).toBe(true);
    expect(toConversationSummary({ ...raw, ready_at: null }).ready).toBe(false);
  });

  // A server that predates the column sends nothing. Absent must read as "no
  // claim": a missing mark costs a glance, a false one would say work had
  // landed when it had not.
  test('an older server that sends no field reads as no claim', () => {
    expect(toConversationSummary(raw).ready).toBe(false);
  });
});

describe('conversationLabel', () => {
  test('uses the title when there is one', () => {
    expect(conversationLabel(conv())).toBe('Debug the migration');
  });

  test('falls back for a chat the server has not titled yet', () => {
    // A brand-new chat has no title until the first message is summarized;
    // without the fallback the switcher renders a blank row.
    expect(conversationLabel(conv({ title: null }))).toBe(UNTITLED_CHAT);
    expect(conversationLabel(conv({ title: '' }))).toBe(UNTITLED_CHAT);
    expect(conversationLabel(conv({ title: '   ' }))).toBe(UNTITLED_CHAT);
  });
});

describe('byMostRecent', () => {
  const sorted = (cs: ConversationSummary[]): (string | null)[] =>
    [...cs].sort(byMostRecent).map(c => c.id);

  test('puts the most recently active first', () => {
    const older = conv({ id: 'older', lastActivityAt: '2026-06-01T10:00:00Z' });
    const newer = conv({ id: 'newer', lastActivityAt: '2026-06-09T10:00:00Z' });
    expect(sorted([older, newer])).toEqual(['newer', 'older']);
  });

  test('sorts a never-active chat last rather than first', () => {
    // A null date must not sort above real activity, or a stale empty chat
    // would open by default.
    const active = conv({ id: 'active', lastActivityAt: '2026-06-01T10:00:00Z' });
    const never = conv({ id: 'never', lastActivityAt: null });
    expect(sorted([never, active])).toEqual(['active', 'never']);
  });

  test('treats equal timestamps as equal', () => {
    expect(byMostRecent(conv({ id: 'a' }), conv({ id: 'b' }))).toBe(0);
  });
});

describe('parseConversationColor', () => {
  test('accepts every color in the palette', () => {
    expect(parseConversationColor('magenta')).toBe('magenta');
    expect(parseConversationColor('blue')).toBe('blue');
    expect(parseConversationColor('red')).toBe('red');
  });

  test('no color is the default', () => {
    expect(parseConversationColor(null)).toBeNull();
    expect(parseConversationColor(undefined)).toBeNull();
  });

  test('an unrecognized value reads as no color rather than a blank swatch', () => {
    // A value written by a newer build, or hand-edited, must not render an
    // empty circle or reach the style attribute.
    expect(parseConversationColor('chartreuse')).toBeNull();
    expect(parseConversationColor('')).toBeNull();
    expect(parseConversationColor('MAGENTA')).toBeNull();
  });
});

describe('colorToken', () => {
  test('maps a color to a design token, never a raw hex', () => {
    expect(colorToken('magenta')).toBe('var(--lbl-plum)');
    expect(colorToken('blue')).toBe('var(--lbl-blue)');
    expect(colorToken('green')).toBe('var(--lbl-green)');
  });

  test('no color maps to no token', () => {
    expect(colorToken(null)).toBeNull();
  });

  // Six labels are only useful while they stay telling apart. Pointing two of
  // them at the same token is a one-character mistake that looks fine in a
  // diff and renders as two identical dots — which is exactly what happened
  // when magenta and violet were both re-pointed at --accent.
  test('no two colors share a token', () => {
    const tokens = CONVERSATION_COLORS.map(c => c.token);
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  // A label must answer to nothing but itself. On --warning or --accent it
  // follows a status or theme retune somewhere it was never meant to go.
  test('every token comes from the label palette', () => {
    for (const { value, token } of CONVERSATION_COLORS) {
      expect(`${value}: ${token}`).toMatch(/: var\(--lbl-[a-z]+\)$/);
    }
  });
});

describe('conversationMonogram', () => {
  test('uses the initials of the first two words', () => {
    expect(conversationMonogram(conv({ title: 'Debug the migration' }))).toBe('DT');
    expect(conversationMonogram(conv({ title: 'Console chat rail' }))).toBe('CC');
  });

  test('uses the first two letters of a single word', () => {
    expect(conversationMonogram(conv({ title: 'Migration' }))).toBe('MI');
  });

  test('an untitled chat still gets a tile', () => {
    // A blank tile reads as a loading state that never resolves.
    // "Untitled chat" is two words, so it takes their initials like any other.
    expect(conversationMonogram(conv({ title: null }))).toBe('UC');
  });

  test('falls back rather than rendering an empty tile', () => {
    expect(conversationMonogram(conv({ title: '!!! ???' }))).toBe('??');
  });
});

describe('matchesFilter', () => {
  test('matches on any part of the title, ignoring case', () => {
    const c = conv({ title: 'Debug the migration' });
    expect(matchesFilter(c, 'migration')).toBe(true);
    expect(matchesFilter(c, 'MIGRA')).toBe(true);
    expect(matchesFilter(c, 'debug')).toBe(true);
  });

  test('an empty query matches everything, so clearing the box restores the list', () => {
    expect(matchesFilter(conv(), '')).toBe(true);
    expect(matchesFilter(conv(), '   ')).toBe(true);
  });

  test('a non-match is excluded', () => {
    expect(matchesFilter(conv({ title: 'Debug the migration' }), 'deploy')).toBe(false);
  });

  test('an untitled chat is findable by its fallback label', () => {
    expect(matchesFilter(conv({ title: null }), 'untitled')).toBe(true);
  });
});

describe('toConversationSummary — done', () => {
  const raw = (over: Record<string, unknown> = {}) => ({
    id: 'db-1',
    platform_conversation_id: 'web-1',
    platform_type: 'web',
    title: 'Refund reconciliation',
    last_activity_at: '2026-06-05T10:00:00Z',
    color: null,
    ai_assistant_type: 'claude',
    ...over,
  });

  test('the chat carries the assistant that answers it', () => {
    // What the agent avatar paints. Read off the row rather than guessed from
    // the current default, so a codex chat keeps its mark after the default
    // moves to claude.
    expect(toConversationSummary(raw({ ai_assistant_type: 'codex' })).assistant).toBe('codex');
  });

  test('a completed_at timestamp reads as done', () => {
    expect(toConversationSummary(raw({ completed_at: '2026-06-07T10:00:00Z' })).completed).toBe(
      true
    );
  });

  test('no timestamp is not done — including from a server without the column', () => {
    expect(toConversationSummary(raw({ completed_at: null })).completed).toBe(false);
    expect(toConversationSummary(raw()).completed).toBe(false);
  });

  test('a soft-deleted row says nothing about being done', () => {
    // `deleted_at` used to be read here as `archived` and rendered as a second
    // lifecycle flag. It is a soft delete again: the console never lists these
    // rows, and if one arrives it is judged on `completed_at` like any other.
    expect(toConversationSummary(raw({ deleted_at: '2026-06-06T10:00:00Z' })).completed).toBe(
      false
    );
  });
});

describe('byArrangement', () => {
  const placed = (id: string, sortOrder: number | null, at: string) =>
    conv({ id, sortOrder, lastActivityAt: at });

  const order = (...cs: ConversationSummary[]) => [...cs].sort(byArrangement).map(c => c.id);

  test('the stored position decides, whatever recency says', () => {
    // The reported bug: a reply landing in an older chat used to move it.
    expect(
      order(placed('a', 2, '2026-06-05T10:00:00Z'), placed('b', 1, '2026-01-01T10:00:00Z'))
    ).toEqual(['b', 'a']);
  });

  test('a chat with no position yet leads, newest of those first', () => {
    expect(
      order(
        placed('placed', 1, '2020-01-01T10:00:00Z'),
        placed('older-new', null, '2026-06-05T10:00:00Z'),
        placed('newer-new', null, '2026-06-06T10:00:00Z')
      )
    ).toEqual(['newer-new', 'older-new', 'placed']);
  });

  test('two chats sharing a position are broken apart by recency', () => {
    // Legal: the rail renumbers one archive scope at a time, so an archived
    // chat can hold the same value as an active one.
    expect(
      order(placed('older', 3, '2026-01-01T10:00:00Z'), placed('newer', 3, '2026-06-05T10:00:00Z'))
    ).toEqual(['newer', 'older']);
  });

  test('a negative position is as ordinary as any other', () => {
    // Seeding a never-arranged chat extends the range downward.
    expect(
      order(placed('a', 0, '2026-01-01T10:00:00Z'), placed('b', -2, '2026-01-01T10:00:00Z'))
    ).toEqual(['b', 'a']);
  });
});

describe('toConversationSummary — ids', () => {
  test('keeps the platform id and the DB uuid apart', () => {
    const summarized = toConversationSummary({
      id: '0f4c9f2e-3b41-4d0a-9a11-0b4c2e7d1a55',
      platform_conversation_id: 'web-1750000000-abc',
      platform_type: 'web',
      title: 'Ship the console',
      last_activity_at: '2026-06-05T10:00:00Z',
      color: null,
      ai_assistant_type: 'claude',
    });

    expect(summarized.id).toBe('web-1750000000-abc');
    expect(summarized.dbId).toBe('0f4c9f2e-3b41-4d0a-9a11-0b4c2e7d1a55');
  });
});

describe('resolveConversationDbId', () => {
  const conversations = [
    conv({ id: 'web-1750000000-abc', dbId: 'db-uuid-abc' }),
    conv({ id: 'web-1750000001-def', dbId: 'db-uuid-def' }),
  ];

  test('matches on the platform id and returns the DB uuid, not the platform id', () => {
    expect(resolveConversationDbId(conversations, 'web-1750000001-def')).toBe('db-uuid-def');
  });

  test('does not match a DB uuid against the platform id', () => {
    expect(resolveConversationDbId(conversations, 'db-uuid-def')).toBeNull();
  });

  test('is null for an unknown chat, an empty list, and no active chat', () => {
    expect(resolveConversationDbId(conversations, 'web-nope')).toBeNull();
    expect(resolveConversationDbId([], 'web-1750000000-abc')).toBeNull();
    expect(resolveConversationDbId(conversations, null)).toBeNull();
  });
});
