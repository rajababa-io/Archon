import { describe, expect, test } from 'bun:test';
import { toBranchName } from '@archon/git';
import { readConversationCheckout, type CheckoutGit } from './conversation-checkout';

const PROJECT = { default_cwd: '/repos/app' };

function fakeGit(overrides: Partial<CheckoutGit> = {}): CheckoutGit {
  return {
    readCheckoutStatus: async () => ({ branch: toBranchName('dev'), dirty: false }),
    getGitCheckoutIdentity: async () => ({
      gitDir: '/repos/app/.git/worktrees/x',
      commonGitDir: '/repos/app/.git',
      linkedWorktree: true,
    }),
    ...overrides,
  };
}

describe('readConversationCheckout', () => {
  test('a chat with no folder of its own runs in the live checkout', async () => {
    let identityAsked = false;
    const result = await readConversationCheckout(
      { cwd: null },
      PROJECT,
      fakeGit({
        getGitCheckoutIdentity: async () => {
          identityAsked = true;
          throw new Error('should not be asked');
        },
      })
    );
    expect(result).toEqual({ path: '/repos/app', location: 'live', branch: 'dev', dirty: false });
    expect(identityAsked).toBe(false);
  });

  test('a chat moved into a linked worktree says worktree, with its branch', async () => {
    const result = await readConversationCheckout(
      { cwd: '/wt/feat-x' },
      PROJECT,
      fakeGit({
        readCheckoutStatus: async () => ({ branch: toBranchName('feat/x'), dirty: true }),
      })
    );
    expect(result).toEqual({
      path: '/wt/feat-x',
      location: 'worktree',
      branch: 'feat/x',
      dirty: true,
    });
  });

  test('a folder that is neither the project nor a linked worktree names no location', async () => {
    const result = await readConversationCheckout(
      { cwd: '/elsewhere' },
      PROJECT,
      fakeGit({
        getGitCheckoutIdentity: async () => ({
          gitDir: '/elsewhere/.git',
          commonGitDir: '/elsewhere/.git',
          linkedWorktree: false,
        }),
      })
    );
    expect(result.location).toBeNull();
  });

  test('an unreadable git status is unknown, not clean', async () => {
    const result = await readConversationCheckout(
      { cwd: null },
      PROJECT,
      fakeGit({
        readCheckoutStatus: async () => {
          throw new Error('fatal: not a git repository');
        },
      })
    );
    expect(result).toEqual({ path: '/repos/app', location: 'live', branch: null, dirty: null });
  });

  test('an unreadable worktree identity is unknown, not live', async () => {
    const result = await readConversationCheckout(
      { cwd: '/wt/gone' },
      PROJECT,
      fakeGit({
        getGitCheckoutIdentity: async () => {
          throw new Error('ENOENT');
        },
      })
    );
    expect(result.location).toBeNull();
  });

  test('a chat with no project reports nothing', async () => {
    expect(await readConversationCheckout({ cwd: null }, null, fakeGit())).toEqual({
      path: null,
      location: null,
      branch: null,
      dirty: null,
    });
  });
});
