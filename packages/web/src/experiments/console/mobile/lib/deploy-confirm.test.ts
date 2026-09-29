import { describe, expect, test } from 'bun:test';
import type { HostDeploy, RemoteDeploy, WorkflowDeploy } from '../../skills/deploy';
import { deployConfirm } from '../../lib/deploy-row';
import { deployConfirmText } from './deploy-confirm';

const TIP = '86b91ff0aa11bb22cc33dd44ee55ff6677889900';

const common = {
  deployOnMerge: false,
  branch: 'deploy',
  live: { sha: null, deployedAt: null },
  waiting: { tipSha: TIP, prs: [], more: false },
  waitingReason: null,
  cancellable: false,
  canAct: true,
};

function host(running: HostDeploy['running']): HostDeploy {
  return { ...common, method: 'archon-host', status: { phase: 'idle' }, running };
}

describe('deployConfirmText', () => {
  test('with work running, the body is the desktop confirm, word for word', () => {
    const running = { chats: 2, workflows: 1 };
    const text = deployConfirmText(host(running), 'Archon', TIP);
    expect(text.title).toBe('Deploy 86b91ff0 now?');
    const desktop = deployConfirm('Archon', running);
    expect(desktop).not.toBeNull();
    expect(text.body).toBe(desktop?.body ?? '');
  });

  test('with nothing running, it still asks, and says what a later chat will meet', () => {
    const text = deployConfirmText(host({ chats: 0, workflows: 0 }), 'Archon', TIP);
    expect(text.body).toContain('Nothing is running now.');
    expect(text.body).toContain('parked and resume after');
  });

  test('a workflow deploy names the workflow it starts', () => {
    const deploy: WorkflowDeploy = {
      ...common,
      method: 'workflow',
      workflowName: 'ship-it',
      run: null,
      blocked: null,
    };
    expect(deployConfirmText(deploy, 'Site', TIP).body).toBe(
      'This runs the ship-it workflow on 86b91ff0.'
    );
  });

  test('a remote-host deploy says the host pulls the commit, and pauses nothing here', () => {
    const deploy: RemoteDeploy = { ...common, method: 'remote-host' };
    expect(deployConfirmText(deploy, 'Vault', TIP).body).toBe(
      'The host that runs Vault pulls 86b91ff0 and restarts what it changed.'
    );
  });
});
