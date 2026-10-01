import type { ReactElement } from 'react';
import { relativeTime } from '../../lib/format';
import { shortSha } from '../../lib/deploy-strip';
import { DEPLOYED_COLOR, STATE_COLOR, lineLabel, stateDetail } from './model';
import { codeMapEmptyText, type CodeMapData } from './useCodeMap';

/**
 * The live code map for a phone (#348): the same changes and environments as
 * the desktop diagram, as a vertical list a narrow screen can read. Each row
 * is a coloured dot in the map's own palette; a line that just merged pulses.
 */
export function CodeMapList({ data, now }: { data: CodeMapData; now: number }): ReactElement {
  const { changes, environments, merging } = data;
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col">
        {environments.map(env => (
          <li key={env.id} className="flex items-center gap-2 px-4 py-1.5">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ background: DEPLOYED_COLOR }}
            />
            <span className="text-body font-medium text-text-primary">{env.label}</span>
            <code className="text-mini text-text-secondary">
              {env.sha === null ? 'live commit unknown' : shortSha(env.sha)}
              {env.since !== null ? ` · live ${relativeTime(env.since, now)}` : ''}
            </code>
            <span
              className="ml-auto shrink-0 text-mini font-medium"
              style={{ color: env.behind === 0 ? DEPLOYED_COLOR : STATE_COLOR.merged }}
            >
              {env.behind === 0
                ? 'up to date'
                : `${String(env.behind)}${env.behindMore ? '+' : ''} behind`}
            </span>
          </li>
        ))}
        {environments.map(env =>
          env.lastFailure === null ? null : (
            <li
              key={`${env.id}:failure`}
              className="px-4 pb-1.5 pl-[34px] text-mini text-[color:var(--error)]"
            >
              last deploy: {env.lastFailure.label} · {relativeTime(env.lastFailure.at, now)}
            </li>
          )
        )}
        {changes.map(c => {
          const color = STATE_COLOR[c.state];
          const label = lineLabel(c);
          const row = (
            <>
              <span
                className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${merging.has(c.key) ? 'animate-ping' : ''}`}
                style={{ background: color }}
              />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-body text-text-primary">{label}</span>
                <span className="text-mini" style={{ color }}>
                  {stateDetail(c, now)}
                </span>
              </span>
            </>
          );
          return (
            <li key={c.key} data-state={c.state}>
              {c.url === null ? (
                <div className="flex items-start gap-2 px-4 py-1.5">{row}</div>
              ) : (
                <a
                  href={c.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mobile-row flex items-start gap-2 px-4 py-1.5"
                >
                  {row}
                </a>
              )}
            </li>
          );
        })}
      </ul>
      {changes.length === 0 ? (
        <p className="px-4 text-body text-text-tertiary">{codeMapEmptyText(data)}</p>
      ) : null}
    </div>
  );
}
