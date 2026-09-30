import { type ReactElement } from 'react';
import * as skill from '../skills';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';
import { useHealth } from '../lib/health';
import { SettingsSection } from './SettingsSection';

/** Coerce a field off the open `concurrency` record to a finite number (0 otherwise). */
function num(rec: Record<string, unknown>, key: string): number {
  const n = Number(rec[key]);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Read-only system status: server/adapter/db/version, concurrency, running
 * workflows, active platform adapters, and the update-check. `concurrency` is an
 * open record in the generated type, so each field is coerced defensively rather
 * than destructured.
 */
export function SystemPanel(): ReactElement {
  const { data: health, error: healthError } = useHealth();
  const { data: config } = useEntity(K.config, skill.getConfig);
  const { data: update, error: updateError } = useEntity(K.updateCheck, skill.getUpdateCheck);

  if (healthError !== undefined) {
    return (
      <SettingsSection title="System">
        <p className="text-small text-error">{healthError.message}</p>
      </SettingsSection>
    );
  }
  if (health === undefined) {
    return (
      <SettingsSection title="System">
        <p className="text-small text-text-tertiary">Loading…</p>
      </SettingsSection>
    );
  }

  const platforms = health.activePlatforms ?? [];

  return (
    <SettingsSection title="System">
      <div className="flex flex-col divide-y divide-border">
        <Row label="status" value={health.status} ok={health.status === 'ok'} />
        <Row label="adapter" value={health.adapter} />
        <Row label="database" value={config?.database ?? '—'} />
        <Row label="version" value={health.version ?? '—'} />
        <Row
          label="concurrency"
          value={`${num(health.concurrency, 'active')} / ${num(health.concurrency, 'maxConcurrent')} active`}
        />
        <Row label="running workflows" value={String(health.runningWorkflows)} />

        <div className="flex items-center gap-[13.5px] py-[5.5px]">
          <span className="w-[170px] shrink-0 text-body text-text-tertiary">platforms</span>
          <div className="flex flex-wrap gap-1.5">
            {platforms.length === 0 ? (
              <span className="text-body text-text-tertiary">none</span>
            ) : (
              platforms.map(pl => (
                <span
                  key={pl}
                  className="rounded-md border border-border-bright bg-surface-elevated px-2 py-0.5 text-small font-medium text-text-secondary"
                >
                  {pl}
                </span>
              ))
            )}
          </div>
        </div>

        <div className="flex items-center gap-[13.5px] py-[5.5px]">
          <span className="w-[170px] shrink-0 text-body text-text-tertiary">updates</span>
          <UpdateStatus update={update} error={updateError} />
        </div>
      </div>
    </SettingsSection>
  );
}

/**
 * Update-check line. Distinguishes failed (don't strand on "checking…" forever — the
 * silent-failure trap), still-loading, update-available, and up-to-date.
 */
function UpdateStatus({
  update,
  error,
}: {
  update: skill.UpdateCheckResponse | undefined;
  error: Error | undefined;
}): ReactElement {
  if (error !== undefined) {
    return <span className="text-text-tertiary">update check unavailable</span>;
  }
  if (update === undefined) {
    return <span className="text-text-tertiary">checking…</span>;
  }
  if (update.updateAvailable) {
    return (
      <a
        href={update.releaseUrl}
        target="_blank"
        rel="noreferrer"
        className="text-text-secondary underline-offset-2 hover:text-text-primary hover:underline"
      >
        {update.latestVersion} available →
      </a>
    );
  }
  return <span className="text-text-secondary">Up to date ({update.currentVersion})</span>;
}

function Row({
  label,
  value,
  ok = false,
}: {
  label: string;
  value: string;
  ok?: boolean;
}): ReactElement {
  return (
    <div className="flex items-center gap-[13.5px] py-[5.5px]">
      <span className="w-[170px] shrink-0 text-body text-text-tertiary">{label}</span>
      <span className={`text-body ${ok ? 'text-success' : 'text-text-primary'}`}>{value}</span>
    </div>
  );
}
