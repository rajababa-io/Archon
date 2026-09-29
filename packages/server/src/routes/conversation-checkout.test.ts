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
    countChangesOffBase: async () => 0,
    resolveBaseBranch: async () => 'dev',
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
    expect(result).toEqual({
      path: '/repos/app',
      location: 'live',
      branch: 'dev',
      dirty: false,
      baseBranch: null,
      offBaseFiles: 0,
    });
    expect(identityAsked).toBe(false);
  });

  test('a chat moved into a linked worktree says worktree, with its branch', async () => {
    const result = await readConversationCheckout(
      { cwd: '/wt/feat-x' },
      PROJECT,
      fakeGit({
        readCheckoutStatus: async () => ({ branch: toBranchName('feat/x'), dirty: true }),
        countChangesOffBase: async () => 2,
      })
    );
    expect(result).toEqual({
      path: '/wt/feat-x',
      location: 'worktree',
      branch: 'feat/x',
      dirty: true,
      baseBranch: 'dev',
      offBaseFiles: 2,
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
    expect(result).toEqual({
      path: '/repos/app',
      location: 'live',
      branch: null,
      dirty: null,
      baseBranch: null,
      offBaseFiles: null,
    });
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
      baseBranch: null,
      offBaseFiles: null,
    });
  });

  test('a dirty checkout whose changes are all on the base branch counts none off it', async () => {
    const asked: string[] = [];
    const result = await readConversationCheckout(
      { cwd: null },
      PROJECT,
      fakeGit({
        readCheckoutStatus: async () => ({ branch: toBranchName('dev'), dirty: true }),
        countChangesOffBase: async (path, base) => {
          asked.push(`${path}@${base}`);
          return 0;
        },
      })
    );
    expect(result.dirty).toBe(true);
    expect(result.offBaseFiles).toBe(0);
    expect(asked).toEqual(['/repos/app@dev']);
  });

  test('a clean tree is not compared with the base at all', async () => {
    const result = await readConversationCheckout(
      { cwd: null },
      PROJECT,
      fakeGit({
        countChangesOffBase: async () => {
          throw new Error('should not be asked');
        },
      })
    );
    expect(result.offBaseFiles).toBe(0);
  });

  test('an unreadable comparison is unknown, not clean', async () => {
    const result = await readConversationCheckout(
      { cwd: null },
      PROJECT,
      fakeGit({
        readCheckoutStatus: async () => ({ branch: toBranchName('dev'), dirty: true }),
        countChangesOffBase: async () => {
          throw new Error("No ref for base branch 'dev'");
        },
      })
    );
    expect(result).toMatchObject({ dirty: true, baseBranch: 'dev', offBaseFiles: null });
  });

  test('an unresolvable base branch is unknown, not clean', async () => {
    const result = await readConversationCheckout(
      { cwd: null },
      PROJECT,
      fakeGit({
        readCheckoutStatus: async () => ({ branch: toBranchName('dev'), dirty: true }),
        resolveBaseBranch: async () => {
          throw new Error('origin/HEAD is not set');
        },
      })
    );
    expect(result).toMatchObject({ dirty: true, baseBranch: null, offBaseFiles: null });
  });
});
