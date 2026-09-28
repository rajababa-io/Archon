import type { ProjectDeploy } from '../../skills/deploy';
import { deployConfirm } from '../../lib/deploy-row';
import { shortSha } from '../../lib/deploy-strip';

/**
 * What the phone's inline confirm says before Deploy now goes to the server.
 *
 * The desktop asks only when a host deploy would pause running work; a phone
 * always asks, because a tap lands where a click does not. The body is the
 * desktop's own sentence when work is running, so both screens describe the
 * same pause the same way.
 */
export function deployConfirmText(
  deploy: ProjectDeploy,
  projectName: string,
  tipSha: string
): { title: string; body: string } {
  const title = `Deploy ${shortSha(tipSha)} now?`;
  if (deploy.method === 'workflow') {
    return { title, body: `This runs the ${deploy.workflowName} workflow on ${shortSha(tipSha)}.` };
  }
  const running = deployConfirm(projectName, deploy.running);
  return {
    title,
    body:
      running?.body ??
      'Nothing is running now. Chats that start before the swap are parked and resume after it.',
  };
}
