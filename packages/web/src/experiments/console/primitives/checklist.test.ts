import { describe, test, expect } from 'bun:test';
import { foldChecklist, turnChecklist, type ChecklistCall } from './checklist';

const todoWrite = (todos: { content: string; status: string }[]): ChecklistCall => ({
  name: 'TodoWrite',
  input: { todos: todos.map(t => ({ ...t, activeForm: t.content })) },
});
const create = (subject: string, id?: string): ChecklistCall => ({
  name: 'TaskCreate',
  input: { subject, description: subject },
  ...(id !== undefined ? { output: JSON.stringify({ task: { id, subject } }) } : {}),
});
const update = (taskId: string, input: Record<string, unknown>): ChecklistCall => ({
  name: 'TaskUpdate',
  input: { taskId, ...input },
});

const user = { role: 'user', toolCalls: [] };
const agent = (...toolCalls: ChecklistCall[]): { role: string; toolCalls: ChecklistCall[] } => ({
  role: 'assistant',
  toolCalls,
});

describe('foldChecklist — TodoWrite', () => {
  test('the latest call is the whole list', () => {
    const items = foldChecklist([
      todoWrite([{ content: 'Read the code', status: 'in_progress' }]),
      todoWrite([
        { content: 'Read the code', status: 'completed' },
        { content: 'Write the fix', status: 'in_progress' },
        { content: 'Run the tests', status: 'pending' },
      ]),
    ]);
    expect(items.map(i => [i.text, i.status])).toEqual([
      ['Read the code', 'completed'],
      ['Write the fix', 'in_progress'],
      ['Run the tests', 'pending'],
    ]);
  });

  test('a malformed entry is dropped rather than rendered blank', () => {
    const call: ChecklistCall = {
      name: 'TodoWrite',
      input: {
        todos: [{ content: '', status: 'pending' }, { content: 'ok', status: 'weird' }, null],
      },
    };
    expect(foldChecklist([call])).toEqual([]);
  });
});

describe('foldChecklist — TaskCreate / TaskUpdate', () => {
  test('updates find the task they name, including by the id the output reported', () => {
    const items = foldChecklist([
      create('Investigate', '1'),
      create('Fix', '2'),
      update('1', { status: 'completed' }),
      update('2', { status: 'in_progress' }),
    ]);
    expect(items.map(i => [i.id, i.text, i.status])).toEqual([
      ['1', 'Investigate', 'completed'],
      ['2', 'Fix', 'in_progress'],
    ]);
  });

  test('a live create with no output yet takes the next id, so a following update lands', () => {
    const items = foldChecklist([
      create('One', '1'),
      create('Two'),
      update('2', { status: 'completed' }),
    ]);
    expect(items.map(i => [i.id, i.status])).toEqual([
      ['1', 'pending'],
      ['2', 'completed'],
    ]);
  });

  test('deleted removes the task', () => {
    expect(foldChecklist([create('Gone', '1'), update('1', { status: 'deleted' })])).toEqual([]);
  });

  test('other tools are ignored', () => {
    expect(foldChecklist([{ name: 'Bash', input: { command: 'ls' } }])).toEqual([]);
  });
});

describe('turnChecklist', () => {
  test('a turn that never touched the checklist shows none, even if an earlier turn did', () => {
    const messages = [user, agent(create('Old', '1')), user, agent({ name: 'Read', input: {} })];
    expect(turnChecklist(messages, [])).toBeNull();
  });

  test('an update this turn resolves against a task created in an earlier turn', () => {
    const messages = [
      user,
      agent(create('Carry over', '1')),
      user,
      agent(update('1', { status: 'completed' })),
    ];
    expect(turnChecklist(messages, [])).toEqual([
      { id: '1', text: 'Carry over', status: 'completed' },
    ]);
  });

  test('live calls show before the rows land, and are not applied twice once they do', () => {
    const live = [create('A'), create('B'), update('1', { status: 'in_progress' })];
    // Nothing stored yet for this turn: the stream alone drives the list.
    expect(turnChecklist([user], live)?.map(i => [i.text, i.status])).toEqual([
      ['A', 'in_progress'],
      ['B', 'pending'],
    ]);
    // The first two calls landed with their real ids; only the third is still live.
    const stored = [user, agent(create('A', '1'), create('B', '2'))];
    expect(turnChecklist(stored, live)?.map(i => [i.id, i.status])).toEqual([
      ['1', 'in_progress'],
      ['2', 'pending'],
    ]);
  });
});
