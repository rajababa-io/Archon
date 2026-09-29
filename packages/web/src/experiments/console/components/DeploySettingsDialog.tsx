/**
 * The deploy's settings as one small form (#266, #267): the branch merges land
 * on, the branch production runs from, and the workflow that deploys. Set up
 * deploys opens it empty; the gear on the deploy bar opens it filled in.
 *
 * Branches come from the repository's own list. A name GitHub does not have is
 * warned about, and Save then reads "Save anyway" — the warning is seen before
 * anything is saved, and a branch about to be pushed is still allowed.
 */

import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { DeploySettingsInput } from '../skills/deploy';
import { branchWarning } from '../lib/deploy-row';
import { GHOST, PRIMARY } from './DeployRow';
import { BranchPicker, useDeployBranches } from './BranchPicker';
import { SELECT_CLASS, SelectShell } from './SettingsFormPrimitives';

interface DeploySettingsDialogProps {
  projectId: string;
  title: string;
  initial: DeploySettingsInput;
  /**
   * The project's workflows. Null for a deploy that is not a workflow's: it has
   * no workflow to pick and reads what is live from its own host, not a branch.
   */
  workflows: readonly string[] | null;
  /** What the method is, for a deploy whose method is not a workflow. */
  methodNote?: string;
  footnote?: ReactNode;
  /** Resolves to why the server refused, or null once saved. */
  onSave: (input: DeploySettingsInput) => Promise<string | null>;
  onClose: () => void;
}

export function DeploySettingsDialog({
  projectId,
  title,
  initial,
  workflows,
  methodNote,
  footnote,
  onSave,
  onClose,
}: DeploySettingsDialogProps): ReactElement {
  const branches = useDeployBranches(projectId);
  const [branch, setBranch] = useState(initial.branch);
  const [productionBranch, setProductionBranch] = useState(initial.productionBranch);
  const [workflow, setWorkflow] = useState(initial.workflowName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // With no default known when the dialog opened, preselect the repository's.
  const defaultBranch = branches?.defaultBranch ?? null;
  useEffect(() => {
    if (defaultBranch !== null) setBranch(b => (b === '' ? defaultBranch : b));
  }, [defaultBranch]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return (): void => {
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const isWorkflow = workflows !== null;
  const warned =
    branchWarning(branch, branches) !== null ||
    (isWorkflow && branchWarning(productionBranch, branches) !== null);
  const sameBranch = productionBranch.trim() !== '' && productionBranch.trim() === branch.trim();
  const ready = branch.trim() !== '' && !sameBranch && (!isWorkflow || workflow !== '');

  const save = (): void => {
    setBusy(true);
    setError(null);
    void onSave({
      branch: branch.trim(),
      productionBranch: isWorkflow ? productionBranch.trim() : '',
      workflowName: isWorkflow ? workflow : '',
    }).then(failure => {
      setBusy(false);
      if (failure === null) onClose();
      else setError(failure);
    });
  };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
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
        <h3 className="text-[16px] font-semibold">{title}</h3>
        <BranchPicker
          label="Branch merges land on"
          value={branch}
          onChange={setBranch}
          branches={branches}
        />
        {isWorkflow ? (
          <BranchPicker
            label="Production branch"
            value={productionBranch}
            onChange={setProductionBranch}
            branches={branches}
            noneLabel="None — Archon's deploy runs say what is live"
          />
        ) : null}
        {sameBranch ? (
          <p className="text-small text-error">
            The production branch must differ from the branch merges land on.
          </p>
        ) : null}
        {isWorkflow ? (
          <label className="flex flex-col gap-1 text-small text-text-secondary">
            Workflow
            {workflows.length === 0 ? (
              <span className="whitespace-normal text-body text-text-tertiary">
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
                  {workflows.map(name => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </SelectShell>
            )}
          </label>
        ) : methodNote !== undefined ? (
          <p className="whitespace-normal text-small text-text-tertiary">{methodNote}</p>
        ) : null}
        {footnote !== undefined ? (
          <p className="whitespace-normal text-small text-text-tertiary">{footnote}</p>
        ) : null}
        {error !== null ? <p className="text-small text-error">{error}</p> : null}
        <div className="flex justify-end gap-2.5">
          <button type="button" className={GHOST} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={PRIMARY} disabled={busy || !ready} onClick={save}>
            {warned ? 'Save anyway' : 'Save'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
