import { describe, expect, it } from 'bun:test';
import { groupMessages, progressNoteIds, type MessageGroup } from './message-groups';
import type { Message, MessageRole } from './message';

let n = 0;
const msg = (role: MessageRole, timestamp: string, category: string | null = null): Message => ({
  id: `m${String(++n)}`,
  role,
  content: 'x',
  timestamp,
  toolCalls: [],
  error: null,
  category,
  dispatch: null,
  workflowResult: null,
  files: [],
  usage: null,
});

describe('groupMessages', () => {
  it('returns nothing for an empty transcript', () => {
    expect(groupMessages([])).toEqual([]);
  });

  it('joins consecutive messages from the same sender', () => {
    const groups = groupMessages([
      msg('assistant', '2026-09-22T18:38:49Z'),
      msg('assistant', '2026-09-22T18:38:49Z'),
      msg('assistant', '2026-09-22T18:38:49Z'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.messages).toHaveLength(3);
  });

  it('splits when the sender changes', () => {
    const groups = groupMessages([
      msg('user', '2026-09-22T18:38:02Z'),
      msg('assistant', '2026-09-22T18:38:15Z'),
      msg('user', '2026-09-22T18:40:00Z'),
    ]);
    expect(groups.map(g => g.role)).toEqual(['user', 'assistant', 'user']);
  });

  // The case that started this: the screenshot had three agent messages
  // sharing 6:38:49, each repeating the label and the time. They collapse —
  // and 6:38:15, a different second, keeps its own honest header.
  it('collapses the messages that share a second, and only those', () => {
    const groups = groupMessages([
      msg('user', '2026-09-22T18:38:02Z'),
      msg('assistant', '2026-09-22T18:38:15Z'),
      msg('assistant', '2026-09-22T18:38:49Z'),
      msg('assistant', '2026-09-22T18:38:49Z'),
      msg('assistant', '2026-09-22T18:38:49Z'),
    ]);
    expect(groups).toHaveLength(3);
    expect(groups.map(g => g.messages.length)).toEqual([1, 1, 3]);
  });

  it('takes the timestamp of the message that opened the group', () => {
    const groups = groupMessages([
      msg('assistant', '2026-09-22T18:38:49.100Z'),
      msg('assistant', '2026-09-22T18:38:49.900Z'),
    ]);
    expect(groups[0]?.timestamp).toBe('2026-09-22T18:38:49.100Z');
  });

  it('keys a group by its first message id, not by position', () => {
    const first = msg('assistant', '2026-09-22T18:38:15Z');
    const groups = groupMessages([first, msg('assistant', '2026-09-22T18:38:15Z')]);
    expect(groups[0]?.key).toBe(first.id);
  });

  describe('a header must be true of everything under it', () => {
    it('splits when the displayed second changes', () => {
      const groups = groupMessages([
        msg('assistant', '2026-09-22T18:38:15Z'),
        msg('assistant', '2026-09-22T18:38:16Z'),
      ]);
      expect(groups).toHaveLength(2);
    });

    it('joins messages differing only below the second', () => {
      const groups = groupMessages([
        msg('assistant', '2026-09-22T18:38:49.100Z'),
        msg('assistant', '2026-09-22T18:38:49.900Z'),
      ]);
      expect(groups).toHaveLength(1);
    });

    it('is a split, not a threshold — an hour and a second behave alike', () => {
      const oneSecond = groupMessages([
        msg('assistant', '2026-09-22T18:38:15Z'),
        msg('assistant', '2026-09-22T18:38:16Z'),
      ]);
      const oneHour = groupMessages([
        msg('assistant', '2026-09-22T18:38:15Z'),
        msg('assistant', '2026-09-22T19:38:15Z'),
      ]);
      expect(oneSecond).toHaveLength(2);
      expect(oneHour).toHaveLength(2);
    });

    it('groups by exact string when a timestamp will not parse', () => {
      const same = groupMessages([msg('assistant', 'not-a-date'), msg('assistant', 'not-a-date')]);
      const differ = groupMessages([msg('assistant', 'not-a-date'), msg('assistant', 'nor-this')]);
      expect(same).toHaveLength(1);
      expect(differ).toHaveLength(2);
    });
  });

  describe('messages that render as their own card', () => {
    it('gives a workflow result its own group', () => {
      const groups = groupMessages([
        msg('assistant', '2026-09-22T18:38:15Z'),
        msg('assistant', '2026-09-22T18:38:20Z', 'workflow_result'),
        msg('assistant', '2026-09-22T18:38:25Z'),
      ]);
      expect(groups).toHaveLength(3);
      expect(groups[1]?.messages[0]?.category).toBe('workflow_result');
    });

    it('does not let two cards share a group', () => {
      const groups = groupMessages([
        msg('assistant', '2026-09-22T18:38:20Z', 'workflow_result'),
        msg('assistant', '2026-09-22T18:38:25Z', 'workflow_result'),
      ]);
      expect(groups).toHaveLength(2);
    });
  });

  it('preserves order and loses no message', () => {
    const input = [
      msg('user', '2026-09-22T18:00:00Z'),
      msg('assistant', '2026-09-22T18:00:01Z'),
      msg('assistant', '2026-09-22T18:00:01Z'),
      msg('system', '2026-09-22T18:00:03Z'),
      msg('assistant', '2026-09-22T18:00:04Z'),
    ];
    const flat = groupMessages(input).flatMap(g => g.messages);
    expect(flat.map(m => m.id)).toEqual(input.map(m => m.id));
  });
});

describe('progressNoteIds', () => {
  const at = '2026-09-27T01:43:54Z';
  const text = (role: MessageRole, content: string): Message => ({ ...msg(role, at), content });
  const groupOf = (...messages: Message[]): MessageGroup => {
    const [g] = groupMessages(messages);
    if (g === undefined) throw new Error('no group');
    return g;
  };

  it('folds every text piece but the last in an agent group', () => {
    const note = text('assistant', 'Issue filed, now updating the rule.');
    const answer = text('assistant', 'Rule — LIVE.');
    expect([...progressNoteIds(groupOf(note, answer))]).toEqual([note.id]);
  });

  it('leaves a single-piece reply alone', () => {
    expect(progressNoteIds(groupOf(text('assistant', 'Done.'))).size).toBe(0);
  });

  it('does not let a trailing empty tool-call row make the answer a note', () => {
    const note = text('assistant', 'Checking.');
    const answer = text('assistant', 'Answer.');
    const tools = text('assistant', '');
    expect([...progressNoteIds(groupOf(note, answer, tools))]).toEqual([note.id]);
  });

  it('never folds a piece holding an ask block', () => {
    const block = JSON.stringify({ questions: [{ title: 'Which?', options: [{ label: 'A' }] }] });
    const ask = text('assistant', `Q1:\n\n\`\`\`ask\n${block}\n\`\`\``);
    const answer = text('assistant', 'Answer.');
    expect(progressNoteIds(groupOf(ask, answer)).size).toBe(0);
  });

  it('leaves user and system groups alone', () => {
    expect(progressNoteIds(groupOf(text('user', 'a'), text('user', 'b'))).size).toBe(0);
    expect(progressNoteIds(groupOf(text('system', 'a'), text('system', 'b'))).size).toBe(0);
  });
});
