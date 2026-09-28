/**
 * The deploy bar of a project that has no deploy (#226): a hollow grey dot,
 * "Deploys: not set up", and Set up deploys — nothing else, at the height of
 * the set-up bar so the header does not change size between projects.
 *
 * Set up deploys opens a small picker: the branch whose merges are deployed,
 * and the repository's own workflow that deploys it. Saving gives the project
 * a deploy with Deploy on Merge off; nothing deploys until a person asks.
 */

import { useEffect, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import * as skill from '../skills';
import type { DeploySetup } from '../skills/deploy';
import { HttpError, errorDetail } from '../lib/http';
import { PERSON_ONLY_TITLE } from '../lib/deploy-row';
import { invalidate } from '../store/cache';
import { K } from '../store/keys';
import { GHOST, PRIMARY } from './DeployRow';
import { INPUT_CLASS, SELECT_CLASS, SelectShell } from './SettingsFormPrimitives';

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
        <SetupPicker
          projectId={projectId}
          setup={setup}
          onClose={() => {
            setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

function SetupPicker({
  projectId,
  setup,
  onClose,
}: {
  projectId: string;
  setup: DeploySetup;
  onClose: () => void;
}): ReactElement {
  const [branch, setBranch] = useState(setup.branch ?? '');
  const [workflow, setWorkflow] = useState(setup.workflow ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return (): void => {
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const save = (): void => {
    setBusy(true);
    setError(null);
    skill
      .setUpDeploy(projectId, branch.trim(), workflow)
      .then(() => {
        invalidate(K.projectDeploy(projectId));
        onClose();
      })
      .catch((err: unknown) => {
        setError(
          err instanceof HttpError && err.serverError !== undefined
            ? err.serverError
            : errorDetail(err)
        );
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const ready = branch.trim() !== '' && workflow !== '';

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Set up deploys"
      className="console-root fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
      onMouseDown={onClose}
    >
      <div
        onMouseDown={e => {
          e.stopPropagation();
        }}
        className="flex w-[400px] max-w-full flex-col gap-3 rounded-xl border bg-surface-elevated px-5.5 py-5 text-text-primary"
        style={{ borderColor: 'var(--border-bright)' }}
      >
        <h3 className="text-[16px] font-semibold">Set up deploys</h3>
        <label className="flex flex-col gap-1 text-small text-text-secondary">
          Branch
          <input
            value={branch}
            onChange={e => {
              setBranch(e.target.value);
            }}
            placeholder="main"
            className={INPUT_CLASS}
          />
        </label>
        <label className="flex flex-col gap-1 text-small text-text-secondary">
          Workflow
          {setup.workflows.length === 0 ? (
            <span className="text-body text-text-tertiary">
              This project has no workflows. Add one — usually .archon/workflows/deploy.yaml — to
              its repository.
            </span>
          ) : (
            <SelectShell>
              <select
                value={workflow}
                onChange={e => {
                  setWorkflow(e.target.value);
                }}
                className={SELECT_CLASS}
              >
                {workflow === '' ? <option value="">Choose a workflow</option> : null}
                {setup.workflows.map(name => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </SelectShell>
          )}
        </label>
        <p className="whitespace-normal text-small text-text-tertiary">
          Deploy on Merge starts off. Nothing deploys until you press Deploy now.
        </p>
        {error !== null ? <p className="text-small text-error">{error}</p> : null}
        <div className="flex justify-end gap-2.5">
          <button type="button" className={GHOST} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={PRIMARY} disabled={busy || !ready} onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
