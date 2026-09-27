import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatStatusStrip } from './ChatStatusStrip';
import type { InlineToolCall } from '../primitives/message';

const noop = (): void => undefined;

const TRACE: InlineToolCall[] = [
  { name: 'Read', input: { file_path: 'src/skills/members.ts' }, durationMs: 40 },
  { name: 'Grep', input: { pattern: 'actionType', path: 'src/' }, durationMs: 120 },
  { name: 'Edit', input: { file_path: 'src/lib/activity-log.ts' } },
];

describe('ChatStatusStrip', () => {
  test('a working chat says what it is doing, not that a tool ran', () => {
    const html = renderToStaticMarkup(
      <ChatStatusStrip status="working" trace={TRACE} expanded={false} onToggle={noop} />
    );
    // The sentence, not the tool name — `Edit` alone names the mechanism.
    expect(html).toContain('Editing activity-log.ts');
  });

  test('a working chat with no tool yet is thinking, not blank', () => {
    const html = renderToStaticMarkup(
      <ChatStatusStrip status="working" trace={[]} expanded={false} onToggle={noop} />
    );
    expect(html).toContain('Thinking');
  });

  // The failure this component exists to prevent: an idle-looking screen that
  // cannot be told apart from a broken indicator.
  // The defect this prop exists for: tool calls are buffered in the adapter and
  // written to the database when the TURN ENDS, so mid-turn the trace holds
  // nothing from the turn being watched — and the line read "Thinking" for the
  // entire time the agent was working, or named a tool from the turn before.
  test('a live tool beats the trace, which cannot see the turn in flight', () => {
    const html = renderToStaticMarkup(
      <ChatStatusStrip
        status="working"
        trace={TRACE}
        live={{ name: 'Bash', input: { command: 'bun run lint' } }}
        expanded={false}
        onToggle={noop}
      />
    );
    // `describeActivity` says what the command DOES — the sentence, not the
    // command line. Same rule the trace entries above follow.
    expect(html).toContain('Checking style');
    expect(html).not.toContain('Editing activity-log.ts');
  });

  test('a live tool is what a turn with nothing persisted yet can say', () => {
    const html = renderToStaticMarkup(
      <ChatStatusStrip
        status="working"
        trace={[]}
        live={{ name: 'Read', input: { file_path: 'src/rail.css' } }}
        expanded={false}
        onToggle={noop}
      />
    );
    expect(html).toContain('rail.css');
    expect(html).not.toContain('Thinking');
  });

  test('no live answer falls back to the trace rather than to nothing', () => {
    const html = renderToStaticMarkup(
      <ChatStatusStrip
        status="working"
        trace={TRACE}
        live={null}
        expanded={false}
        onToggle={noop}
      />
    );
    expect(html).toContain('Editing activity-log.ts');
  });

  test('a live tool never speaks for a chat that is not working', () => {
    // Between tools the server still names the last one; the STATE is what
    // decides whether the label is an activity at all.
    const html = renderToStaticMarkup(
      <ChatStatusStrip
        status="idle"
        trace={TRACE}
        live={{ name: 'Bash', input: { command: 'bun run lint' } }}
        expanded={false}
        onToggle={noop}
      />
    );
    expect(html).toContain('Idle');
    expect(html).not.toContain('Checking style');
  });

  test('an idle chat still renders, and says when it last spoke', () => {
    const iso = new Date(Date.now() - 4 * 60_000).toISOString();
    const html = renderToStaticMarkup(
      <ChatStatusStrip
        status="idle"
        lastActivityAt={iso}
        trace={[]}
        expanded={false}
        onToggle={noop}
      />
    );
    expect(html).toContain('Idle');
    expect(html).toContain('4m ago');
  });

  test('a chat waiting on an approval says so', () => {
    const html = renderToStaticMarkup(
      <ChatStatusStrip status="awaiting" trace={[]} expanded={false} onToggle={noop} />
    );
    expect(html).toContain('Needs you');
  });

  test('expanding lists the turn, marking the step still running', () => {
    const html = renderToStaticMarkup(
      <ChatStatusStrip status="working" trace={TRACE} expanded onToggle={noop} />
    );
    expect(html).toContain('members.ts');
    expect(html).toContain('actionType in src/');
    expect(html).toContain('activity-log.ts');
    // Two finished, one still in flight.
    expect(html.split('✓').length - 1).toBe(2);
    expect(html).toContain('·');
  });

  test('collapsed renders the pill alone', () => {
    const html = renderToStaticMarkup(
      <ChatStatusStrip status="working" trace={TRACE} expanded={false} onToggle={noop} />
    );
    expect(html).not.toContain('members.ts');
  });

  test('a long turn collapses its head into a count rather than scrolling away', () => {
    const long: InlineToolCall[] = Array.from({ length: 20 }, (_, i) => ({
      name: 'Read',
      input: { file_path: `file-${String(i)}.ts` },
      durationMs: 5,
    }));
    const html = renderToStaticMarkup(
      <ChatStatusStrip status="working" trace={long} expanded onToggle={noop} />
    );
    expect(html).toContain('8');
    expect(html).toContain('earlier');
    expect(html).not.toContain('file-0.ts');
    expect(html).toContain('file-19.ts');
  });

  // One mark, defined once in rail.css. A spinner here and a dot in the rail
  // would be two vocabularies for one state, which is what the shared status
  // primitive exists to prevent.
  test("wears the rail's own mark rather than a lookalike", () => {
    for (const status of ['working', 'awaiting', 'done', 'idle'] as const) {
      const html = renderToStaticMarkup(
        <ChatStatusStrip status={status} trace={[]} expanded={false} onToggle={noop} />
      );
      expect(html).toContain(`chat-status is-${status}`);
    }
  });

  test('nothing to expand means nothing to click', () => {
    const html = renderToStaticMarkup(
      <ChatStatusStrip status="idle" trace={[]} expanded={false} onToggle={noop} />
    );
    expect(html).toContain('disabled');
    expect(html).not.toContain('details');
  });

  // A CI wait whose webhook never came looks exactly like one about to finish;
  // the clock is what tells them apart (#196).
  test('a CI wait shows how long it has been waiting', () => {
    const html = renderToStaticMarkup(
      <ChatStatusStrip
        status="waiting"
        ciSince={Date.now() - 5 * 60_000}
        ciAlarmMinutes={20}
        trace={[]}
        expanded={false}
        onToggle={noop}
      />
    );
    expect(html).toContain('Waiting on CI');
    expect(html).toContain('5m');
    expect(html).not.toContain('overdue');
    expect(html).not.toContain('var(--warning)');
  });

  test('a CI wait past the alarm turns amber and says overdue', () => {
    const html = renderToStaticMarkup(
      <ChatStatusStrip
        status="waiting"
        ciSince={Date.now() - 25 * 60_000}
        ciAlarmMinutes={20}
        trace={[]}
        expanded={false}
        onToggle={noop}
      />
    );
    expect(html).toContain('25m');
    expect(html).toContain('overdue');
    expect(html).toContain('var(--warning)');
  });

  test('with no start time from the server, a CI wait shows no clock rather than a wrong one', () => {
    const html = renderToStaticMarkup(
      <ChatStatusStrip
        status="waiting"
        ciAlarmMinutes={20}
        trace={[]}
        expanded={false}
        onToggle={noop}
      />
    );
    expect(html).toContain('Waiting on CI');
    expect(html).not.toContain('overdue');
    expect(html).not.toMatch(/\d+m \d+s/);
  });
});
