import { describe, expect, test } from 'bun:test';
import { askAwaitsAnswer, askKeyAction, startRow } from './ask-keys';

const four = { options: 4, own: true, cursor: 1 };
const press = (key: string, mod = false): { key: string; mod: boolean } => ({ key, mod });

describe('askKeyAction', () => {
  // The whole point of the redesign: a letter is navigation, never a commit.
  test('a letter moves the highlight to its row without picking it', () => {
    expect(askKeyAction(press('c'), four)).toEqual({ kind: 'move', row: 2 });
    expect(askKeyAction(press('E'), four)).toEqual({ kind: 'move', row: 4 });
  });

  test('a letter past the last row does nothing', () => {
    expect(askKeyAction(press('f'), four)).toEqual({ kind: 'none' });
    expect(askKeyAction(press('e'), { ...four, own: false })).toEqual({ kind: 'none' });
  });

  test('up and down move the highlight and stop at the ends', () => {
    expect(askKeyAction(press('ArrowDown'), four)).toEqual({ kind: 'move', row: 2 });
    expect(askKeyAction(press('ArrowUp'), four)).toEqual({ kind: 'move', row: 0 });
    expect(askKeyAction(press('ArrowUp'), { ...four, cursor: 0 })).toEqual({
      kind: 'move',
      row: 0,
    });
    expect(askKeyAction(press('ArrowDown'), { ...four, cursor: 4 })).toEqual({
      kind: 'move',
      row: 4,
    });
  });

  test('Enter picks the highlighted option, or opens the own-answer row', () => {
    expect(askKeyAction(press('Enter'), four)).toEqual({ kind: 'pick', row: 1 });
    expect(askKeyAction(press('Enter'), { ...four, cursor: 4 })).toEqual({ kind: 'own' });
  });

  test('⌘/Ctrl+Enter sends; other modified keys are left alone', () => {
    expect(askKeyAction(press('Enter', true), four)).toEqual({ kind: 'submit' });
    expect(askKeyAction(press('a', true), four)).toEqual({ kind: 'none' });
    expect(askKeyAction(press('ArrowDown', true), four)).toEqual({ kind: 'none' });
  });

  test('left and right page, Escape leaves', () => {
    expect(askKeyAction(press('ArrowLeft'), four)).toEqual({ kind: 'page', delta: -1 });
    expect(askKeyAction(press('ArrowRight'), four)).toEqual({ kind: 'page', delta: 1 });
    expect(askKeyAction(press('Escape'), four)).toEqual({ kind: 'leave' });
  });

  test('named keys that happen to start with a letter are not letters', () => {
    expect(askKeyAction(press('Delete'), four)).toEqual({ kind: 'none' });
    expect(askKeyAction(press('Tab'), four)).toEqual({ kind: 'none' });
  });
});

describe('startRow', () => {
  const options = [{ label: 'a' }, { label: 'b', recommended: true }, { label: 'c' }];

  test('starts on the recommendation, so Enter alone takes it', () => {
    expect(startRow(options, [])).toBe(1);
  });

  test('starts on the answer already given when coming back to a question', () => {
    expect(startRow(options, ['c'])).toBe(2);
    expect(startRow(options, ['my own words'])).toBe(3);
  });

  test('starts at the top with no recommendation', () => {
    expect(startRow([{ label: 'a' }, { label: 'b' }], [])).toBe(0);
  });
});

describe('askAwaitsAnswer', () => {
  const ask = '```ask\n{"questions":[{"title":"Ship?","options":[{"label":"Yes"}]}]}\n```';

  test('true when the reply after your last message holds a card', () => {
    expect(
      askAwaitsAnswer([
        { role: 'user', content: 'go' },
        { role: 'assistant', content: `Pick one.\n\n${ask}` },
        { role: 'system', content: 'note' },
      ])
    ).toBe(true);
  });

  // Answering sends a message; that message is what ends the wait.
  test('false once you have replied after the card', () => {
    expect(
      askAwaitsAnswer([
        { role: 'assistant', content: ask },
        { role: 'user', content: '1. Ship?\n   Yes' },
      ])
    ).toBe(false);
  });

  test('false for a reply without a card', () => {
    expect(askAwaitsAnswer([{ role: 'assistant', content: 'done' }])).toBe(false);
  });
});
