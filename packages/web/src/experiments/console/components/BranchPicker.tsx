/**
 * A branch field that offers the repository's real branches (#267): a list
 * from GitHub with the default first, and "Other…" for a name that is not
 * there yet. A name GitHub does not have is warned about under the field,
 * never refused — the caller decides what saving past a warning means.
 */

import { useState, type ReactElement } from 'react';
import * as skill from '../skills';
import type { DeployBranches } from '../skills/deploy';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';
import { branchWarning } from '../lib/deploy-row';
import { INPUT_CLASS, SELECT_CLASS, SelectShell } from './SettingsFormPrimitives';

// Git refuses a space in a branch name, so no real branch can collide with it.
const OTHER = ' other';
const NONE = '';

interface BranchPickerProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Undefined while the list is loading. */
  branches: DeployBranches | undefined;
  /** The words for choosing no branch at all. Omit when a branch is required. */
  noneLabel?: string;
}

export function BranchPicker({
  label,
  value,
  onChange,
  branches,
  noneLabel,
}: BranchPickerProps): ReactElement {
  const listed = branches?.branches ?? [];
  // Typing is the only way to name a branch the list lacks, so a value the
  // list lacks opens the text field — including when the list never arrived.
  const [typing, setTyping] = useState(false);
  const typed = typing || (value !== '' && !listed.includes(value)) || listed.length === 0;
  const warning = branchWarning(value, branches);

  return (
    <label className="flex flex-col gap-1 text-small text-text-secondary">
      {label}
      {typed ? (
        <span className="flex gap-2">
          <input
            value={value}
            onChange={e => {
              onChange(e.target.value);
            }}
            placeholder={noneLabel === undefined ? 'branch name' : 'none'}
            className={INPUT_CLASS}
          />
          {listed.length > 0 ? (
            <button
              type="button"
              className="shrink-0 text-small text-text-tertiary underline underline-offset-2 hover:text-text-primary"
              onClick={() => {
                setTyping(false);
                if (!listed.includes(value))
                  onChange(noneLabel === undefined ? (listed.at(0) ?? '') : NONE);
              }}
            >
              Pick from list
            </button>
          ) : null}
        </span>
      ) : (
        <SelectShell>
          <select
            value={value}
            onChange={e => {
              if (e.target.value === OTHER) {
                setTyping(true);
                onChange('');
              } else {
                onChange(e.target.value);
              }
            }}
            className={SELECT_CLASS}
          >
            {noneLabel !== undefined ? <option value={NONE}>{noneLabel}</option> : null}
            {listed.map(name => (
              <option key={name} value={name}>
                {name}
                {name === branches?.defaultBranch ? ' (default)' : ''}
              </option>
            ))}
            <option value={OTHER}>Other…</option>
          </select>
        </SelectShell>
      )}
      {warning !== null ? (
        <span role="alert" className="whitespace-normal text-small text-warning">
          {warning}
        </span>
      ) : null}
    </label>
  );
}

/**
 * The repository's branches, read once per project and shared by every picker.
 * A failed read is a list that says why, so the pickers warn instead of
 * waiting forever.
 */
export function useDeployBranches(projectId: string): DeployBranches | undefined {
  const { data, error } = useEntity(K.projectDeployBranches(projectId), () =>
    skill.getDeployBranches(projectId)
  );
  if (error !== undefined && error !== null) {
    return { branches: [], defaultBranch: null, complete: false, reason: 'unreachable' };
  }
  return data;
}
