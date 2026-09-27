import { describe, test, expect } from 'bun:test';
import { HIDDEN_COLUMNS_KEY, parseHiddenColumns } from './issue-columns';

describe('parseHiddenColumns', () => {
  test('reads back the columns that were hidden', () => {
    expect([...parseHiddenColumns('["todo","done"]')].sort()).toEqual(['done', 'todo']);
  });

  test('an absent preference hides nothing', () => {
    expect(parseHiddenColumns(null).size).toBe(0);
  });

  test('an unparseable or wrongly shaped value hides nothing rather than throwing', () => {
    expect(parseHiddenColumns('not json').size).toBe(0);
    expect(parseHiddenColumns('{"todo":true}').size).toBe(0);
    expect(parseHiddenColumns('"todo"').size).toBe(0);
  });

  test('drops keys that are not a column, such as one from an older build', () => {
    expect([...parseHiddenColumns('["todo","backlog",3]')]).toEqual(['todo']);
  });

  test('a value that hides every column hides nothing, so the board is never empty', () => {
    expect(parseHiddenColumns('["todo","blocked","prog","rev","done"]').size).toBe(0);
  });
});

test('the key is namespaced and not scoped to a project', () => {
  expect(HIDDEN_COLUMNS_KEY).toStartWith('archon.console.');
});
