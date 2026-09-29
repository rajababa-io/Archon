import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ARCHON_HOST_DEPLOY_POINTER, namesDeployPointer } from './project-deploy-rules';

describe('the deploy pointer', () => {
  const base = { codebaseId: 'p1', deployOnMerge: false, updatedAt: '', updatedBy: null };

  test('is the branch deploy-local.sh pushes to by default', () => {
    const script = readFileSync(
      resolve(import.meta.dir, '../../../../scripts/deploy-local.sh'),
      'utf8'
    );
    expect(script).toContain(`REMOTE_BRANCH="\${REMOTE_BRANCH:-${ARCHON_HOST_DEPLOY_POINTER}}"`);
  });

  test('an archon-host row naming the deploy pointer is flagged; one naming dev is not', () => {
    expect(namesDeployPointer({ ...base, method: 'archon-host', branch: 'deploy' })).toBe(true);
    expect(namesDeployPointer({ ...base, method: 'archon-host', branch: 'dev' })).toBe(false);
  });

  test('a workflow project may merge into a branch called deploy', () => {
    expect(
      namesDeployPointer({ ...base, method: 'workflow', branch: 'deploy', workflowName: 'd' })
    ).toBe(false);
  });
});
