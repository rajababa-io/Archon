import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { chatStatusSets } from '../primitives/chat-status';
import type { ConversationSummary } from '../primitives/conversation';
import { ConversationRail } from './ConversationRail';

const chat = (id: string, completed = false): ConversationSummary => ({
  id,
  dbId: `db-${id}`,
  title: id,
  platformType: 'web',
  lastActivityAt: '2026-09-01T10:00:00.000Z',
  color: null,
  assistant: 'claude',
  completed,
  askCandidate: null,
  sortOrder: null,
  lastReadAt: null,
  ready: false,
  projectId: null,
});

const ASK = '```ask\n{"questions":[{"id":"q1","question":"Pick one","options":["a","b"]}]}\n```';

const NO_LIVE = {
  working: new Set<string>(),
  runAwaiting: new Set<string>(),
  running: new Set<string>(),
  waiting: new Set<string>(),
};

const draw = (overrides: Partial<Parameters<typeof ConversationRail>[0]> = {}): string =>
  renderToStaticMarkup(
    <ConversationRail
      conversations={[chat('one'), chat('two')]}
      activeConvId={null}
      onSelect={() => undefined}
      onRename={() => undefined}
      onComplete={() => undefined}
      onMarkUnread={() => undefined}
      onReorder={() => undefined}
      scope="open"
      onScopeChange={() => undefined}
      openCount={2}
      doneCount={0}
      omitted={0}
      pendingNew={false}
      projectId="project-1"
      statusSets={chatStatusSets(overrides.conversations ?? [chat('one'), chat('two')], NO_LIVE)}
      {...overrides}
    />
  );

describe('ConversationRail — scope counts', () => {
  test('the tabs count what the server counted, not what is on screen', () => {
    // The rendered list is one scope's, and a capped one. Reading its length
    // made every tab agree with whichever scope happened to be showing.
    const html = draw({
      scope: 'done',
      conversations: [chat('a', true)],
      openCount: 7,
      doneCount: 112,
    });
    expect(html).toContain('>7<');
    expect(html).toContain('>112<');
  });

  test('a scope with nothing in it shows no number', () => {
    // Silence says "nothing finished yet"; a 0 says the same thing louder and
    // puts a digit in a column that is otherwise empty.
    const html = draw({ openCount: 2, doneCount: 0 });
    expect(html).not.toContain('>0<');
  });
});

describe('ConversationRail — truncation', () => {
  test('says how many chats it is not showing', () => {
    const html = draw({ omitted: 62 });
    expect(html).toContain('62 older chats not shown.');
  });

  test('one omitted chat is singular', () => {
    expect(draw({ omitted: 1 })).toContain('1 older chat not shown.');
  });

  test('a complete list says nothing', () => {
    // The whole failure mode: a list that stopped at the cap looked exactly
    // like one that had reached the end.
    expect(draw({ omitted: 0 })).not.toContain('not shown');
  });
});

describe('ConversationRail — New chat', () => {
  test('the button shows its shortcut, and no longer the old C', () => {
    const html = draw({ activeConvId: 'one' });
    expect(html).toContain('⌘⇧O');
    expect(html).toContain('aria-keyshortcuts="Meta+Shift+O Control+Shift+O"');
    expect(html).not.toContain('(C)');
  });
});

describe('ConversationRail — status', () => {
  test('the dot is drawn from the sets it is given, not from its own copy (#217)', () => {
    // The page hands the same object to the status bar. A rail that rebuilt
    // the sets itself is how the two came to disagree.
    const rows = [{ ...chat('asked'), ready: true, askCandidate: ASK }];
    const html = draw({ conversations: rows, statusSets: chatStatusSets(rows, NO_LIVE) });
    expect(html).toContain('chat-status is-awaiting');
    expect(html).not.toContain('chat-status is-ready');
  });
});

describe('ConversationRail — issue numbers in a title (#119)', () => {
  const titled = (title: string): ConversationSummary => ({ ...chat('t'), title });

  test('each leading #N is its own button; the +N count is not', () => {
    const rows = [titled('#99 #100 +3 Console polish')];
    const html = draw({ conversations: rows, statusSets: chatStatusSets(rows, NO_LIVE) });
    expect(html.match(/class="chat-issue"/g)).toHaveLength(2);
    expect(html).toContain('>#99</button>');
    expect(html).toContain('>#100</button>');
    expect(html).not.toContain('>+3</button>');
    expect(html).toContain('+3 Console polish');
  });

  test('the title is never inside the button that opens the chat', () => {
    // A button inside a button is invalid, and its click would open both.
    const rows = [titled('#96 Ask card')];
    const html = draw({ conversations: rows, statusSets: chatStatusSets(rows, NO_LIVE) });
    expect(html).toContain('aria-label="#96 Ask card" class="chat-open"></button>');
  });

  test('a title with no leading number has no issue buttons', () => {
    const rows = [titled('Fix the #3 regression')];
    const html = draw({ conversations: rows, statusSets: chatStatusSets(rows, NO_LIVE) });
    expect(html).not.toContain('chat-issue');
    expect(html).toContain('<span class="rail-text">Fix the #3 regression</span>');
  });
});

describe('ConversationRail — row menu (#255)', () => {
  test('every row has a ⋯ button, so the menu does not depend on right-click', () => {
    // iOS Safari fires no contextmenu on long-press; a menu reachable only by
    // right-click could not be opened on an iPhone at all.
    const html = draw({ conversations: [chat('one'), chat('two'), chat('three')] });
    expect(html.match(/aria-label="More actions"/g)?.length).toBe(3);
    expect(html).toContain('aria-haspopup="menu"');
  });
});
