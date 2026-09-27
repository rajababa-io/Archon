import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { IAgentProvider, ProviderCommand } from '@archon/providers/types';
import {
  clearProviderCommandCache,
  listProviderCommands,
  matchProviderCommand,
  spellProviderCommands,
} from './provider-commands';
import { SLASH_COMMANDS } from './command-registry';

const cmd = (name: string, over: Partial<ProviderCommand> = {}): ProviderCommand => ({
  name,
  sigil: '/',
  args: '',
  description: name,
  kind: 'command',
  origin: 'provider',
  ...over,
});

describe('spellProviderCommands', () => {
  test('keeps every provider command, renaming only the ones Archon owns', () => {
    const reported = [
      cmd('compact'),
      cmd('status', { kind: 'skill', origin: 'user' }),
      cmd('init'),
      cmd('retitle'),
      cmd('imagegen', { sigil: '$' }),
      // `$status` is not `/status`: a different sigil never clashes.
      cmd('status', { sigil: '$' }),
    ];
    const spelled = spellProviderCommands('claude', reported);
    expect(spelled.map(c => c.invocation)).toEqual([
      '/compact',
      '/claude:status',
      '/claude:init',
      '/claude:retitle',
      '$imagegen',
      '$status',
    ]);
    // The provider still receives its own name.
    expect(spelled[1]?.name).toBe('status');
  });

  test('no provider command is spelled like an Archon command', () => {
    const spelled = spellProviderCommands(
      'claude',
      SLASH_COMMANDS.map(spec => cmd(spec.name))
    );
    expect(spelled).toHaveLength(SLASH_COMMANDS.length);
    for (const c of spelled) expect(c.invocation.startsWith('/claude:')).toBe(true);
  });
});

describe('matchProviderCommand', () => {
  const commands = spellProviderCommands('claude', [
    cmd('compact'),
    cmd('status', { kind: 'skill', origin: 'user' }),
    cmd('imagegen', { sigil: '$' }),
  ]);

  test('matches the exact invocation as the first word and passes the rest as args', () => {
    expect(matchProviderCommand('/compact', commands)?.invocation).toEqual({
      name: 'compact',
      args: '',
    });
    expect(matchProviderCommand('  /compact keep the plan \n', commands)?.invocation).toEqual({
      name: 'compact',
      args: 'keep the plan',
    });
    expect(matchProviderCommand('/claude:status now', commands)?.invocation).toEqual({
      name: 'status',
      args: 'now',
    });
    expect(matchProviderCommand('$imagegen a fox', commands)?.invocation.name).toBe('imagegen');
  });

  test('a message that starts with / by accident is not a command', () => {
    expect(matchProviderCommand('/etc/hosts is stale', commands)).toBeUndefined();
    expect(matchProviderCommand('/compacted is not a word', commands)).toBeUndefined();
    expect(matchProviderCommand('/status', commands)).toBeUndefined();
    expect(matchProviderCommand('$5 is the price', commands)).toBeUndefined();
    expect(matchProviderCommand('please /compact', commands)).toBeUndefined();
  });
});

describe('listProviderCommands', () => {
  beforeEach(() => {
    clearProviderCommandCache();
  });

  const provider = (listCommands?: IAgentProvider['listCommands']): IAgentProvider => ({
    sendQuery: async function* () {},
    getType: () => 'claude',
    getCapabilities: () => ({}) as ReturnType<IAgentProvider['getCapabilities']>,
    ...(listCommands ? { listCommands } : {}),
  });

  test('a provider without listCommands offers none', async () => {
    expect(await listProviderCommands('pi', provider(), '/repo')).toEqual({
      commands: [],
      withheld: [],
    });
  });

  test('caches per provider and directory rather than asking on every call', async () => {
    const list = mock(async () => ({ commands: [cmd('compact')], withheld: [] }));
    const p = provider(list);
    await listProviderCommands('claude', p, '/repo');
    await listProviderCommands('claude', p, '/repo');
    expect(list).toHaveBeenCalledTimes(1);
    await listProviderCommands('claude', p, '/other');
    expect(list).toHaveBeenCalledTimes(2);
  });

  test('a failed listing is not cached', async () => {
    let calls = 0;
    const p = provider(async () => {
      calls++;
      if (calls === 1) throw new Error('boom');
      return { commands: [cmd('compact')], withheld: [] };
    });
    await expect(listProviderCommands('claude', p, '/repo')).rejects.toThrow('boom');
    const second = await listProviderCommands('claude', p, '/repo');
    expect(second.commands.map(c => c.invocation)).toEqual(['/compact']);
  });
});
