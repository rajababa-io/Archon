/**
 * The deploy bar of a project that has no deploy (#226): a hollow grey dot,
 * "Deploys: not set up", and Set up deploys — nothing else, at the height of
 * the set-up bar so the header does not change size between projects.
 *
 * Set up deploys opens a small picker: the branch whose merges are deployed,
 * the branch production runs from when merging into it is the deploy, and the
 * repository's own workflow that deploys it. Saving gives the project a deploy
 * with Deploy on Merge off; nothing deploys until a person asks.
 */

import { useState, type ReactElement } from 'react';
import * as skill from '../skills';
import type { DeploySettingsInput, DeploySetup } from '../skills/deploy';
import { HttpError, errorDetail } from '../lib/http';
import { PERSON_ONLY_TITLE } from '../lib/deploy-row';
import { invalidate } from '../store/cache';
import { K } from '../store/keys';
import { GHOST } from './DeployRow';
import { DeploySettingsDialog } from './DeploySettingsDialog';

interface DeploySetupRowProps {
  projectId: string;
  setup: DeploySetup;
  canAct: boolean;
}

export function DeploySetupRow({ projectId, setup, canAct }: DeploySetupRowProps): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div
        data-testid="deploy-setup-row"
        className="-mx-4.75 flex h-9 shrink-0 items-center gap-4 overflow-x-auto whitespace-nowrap border-y bg-surface-inset px-4.75 text-body max-md:gap-2.5"
      >
        <span className="inline-flex shrink-0 items-center gap-1.75">
          <span
            aria-hidden
            className="size-2 rounded-full ring-[1.5px] ring-inset ring-text-tertiary"
          />
          <span className="text-text-secondary">Deploys: not set up</span>
        </span>
        <button
          type="button"
          className={GHOST}
          disabled={!canAct}
          title={canAct ? undefined : PERSON_ONLY_TITLE}
          onClick={() => {
            setOpen(true);
          }}
        >
          Set up deploys
        </button>
      </div>
      {open ? (
        <DeploySettingsDialog
          projectId={projectId}
          title="Set up deploys"
          initial={{
            branch: setup.branch ?? '',
            productionBranch: '',
            workflowName: setup.workflow ?? '',
          }}
          workflows={setup.workflows}
          footnote="Deploy on Merge starts off. Nothing deploys until you press Deploy now."
          onSave={input => saveDeploySetup(projectId, input)}
          onClose={() => {
            setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

/** Give the project its deploy. Resolves to why the server refused, or null once it exists. */
export async function saveDeploySetup(
  projectId: string,
  input: DeploySettingsInput
): Promise<string | null> {
  try {
    await skill.setUpDeploy(projectId, input);
  } catch (err) {
    return err instanceof HttpError && err.serverError !== undefined
      ? err.serverError
      : errorDetail(err);
  }
  invalidate(K.projectDeploy(projectId));
  return null;
}
