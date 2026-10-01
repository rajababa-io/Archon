import type { ReactElement, ReactNode } from 'react';
import { relativeTime } from '../../lib/format';
import { shortSha } from '../../lib/deploy-strip';
import {
  DEPLOYED_COLOR,
  LEGEND,
  lineLabel,
  STATE_COLOR,
  stateDetail,
  type CodeMapChange,
  type CodeMapEnvironment,
} from './model';
import './code-map.css';

/** The drawing's own coordinate space; the SVG scales it to the column. */
const W = 800;
const LABEL_X = 8;
const TRUNK_X = 84;
const END_X = W - 16;
const TOP = 34;
const LANE = 36;
const ENV_GAP = 70;
/** JetBrains Mono at 11px: the pill widths are computed, not measured. */
const MONO_CHAR = 6.6;
const TITLE_MAX = 32;

const TRUNK_COLOR = 'var(--text-tertiary)';

export interface CodeMapProps {
  /** The trunk's name. */
  base: string | null;
  changes: readonly CodeMapChange[];
  environments: readonly CodeMapEnvironment[];
  /** Keys of lines that just merged; they draw their join into the trunk. */
  merging?: ReadonlySet<string>;
  /**
   * An action for one environment — a Deploy button — drawn between the trunk
   * and that environment's line. The map owns where; the caller owns what.
   */
  renderEnvironmentAction?: (env: CodeMapEnvironment) => ReactNode;
  /** Shown under the trunk when there is no line to draw, or why. */
  emptyText?: string;
  now?: number;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Where lane `i` leaves the trunk: staggered, so the rises do not stack. */
function riseX(i: number): number {
  return TRUNK_X + 40 + (i % 12) * 16;
}

/** Where a merged lane drops back into the trunk. */
function joinX(i: number): number {
  return 450 + (i % 12) * 26;
}

function rise(x: number, fromY: number, toY: number): string {
  return `M ${String(x)} ${String(fromY)} C ${String(x + 18)} ${String(fromY)}, ${String(x + 12)} ${String(toY)}, ${String(x + 30)} ${String(toY)}`;
}

function drop(x: number, fromY: number, toY: number): string {
  return `M ${String(x)} ${String(fromY)} C ${String(x + 24)} ${String(fromY)}, ${String(x + 12)} ${String(toY)}, ${String(x + 36)} ${String(toY)}`;
}

function Lane({
  change,
  index,
  devY,
  merging,
  now,
}: {
  change: CodeMapChange;
  index: number;
  devY: number;
  merging: boolean;
  now: number;
}): ReactElement {
  const y = TOP + index * LANE;
  const x0 = riseX(index);
  const color = STATE_COLOR[change.state];
  const merged = change.state === 'merged';
  const dashed = change.state === 'coding';
  const xEnd = merged ? joinX(index) : END_X - 8;
  const detail = stateDetail(change, now);
  const stroke = {
    stroke: color,
    strokeWidth: 3,
    fill: 'none',
    strokeLinecap: 'round' as const,
    strokeDasharray: dashed ? '7 6' : undefined,
  };

  const body = (
    <g className="code-map-lane" data-state={change.state} data-key={change.key}>
      <title>{`${change.number === null ? change.branch : `PR ${String(change.number)}`}: ${change.title} — ${detail}`}</title>
      <path d={rise(x0, devY, y)} {...stroke} />
      <path d={`M ${String(x0 + 30)} ${String(y)} L ${String(xEnd)} ${String(y)}`} {...stroke} />
      <text x={x0 + 36} y={y - 8} className="code-map-title">
        {truncate(lineLabel(change), TITLE_MAX)}
      </text>
      {merged ? (
        <>
          <path
            d={drop(xEnd, y, devY)}
            {...stroke}
            pathLength={1}
            className={merging ? 'code-map-draw' : undefined}
          />
          <circle
            cx={xEnd + 36}
            cy={devY}
            r={5}
            fill={color}
            className={merging ? 'code-map-pop' : undefined}
          />
          <text x={xEnd + 10} y={y - 8} className="code-map-detail" fill={color}>
            {detail}
          </text>
        </>
      ) : (
        <>
          <text x={END_X - 22} y={y - 8} textAnchor="end" className="code-map-detail" fill={color}>
            {detail}
          </text>
          <EndMark change={change} x={END_X - 4} y={y} color={color} />
        </>
      )}
    </g>
  );

  return change.url === null ? (
    body
  ) : (
    <a href={change.url} target="_blank" rel="noopener noreferrer">
      {body}
    </a>
  );
}

/** How a line still out on its branch ends: what it is waiting for. */
function EndMark({
  change,
  x,
  y,
  color,
}: {
  change: CodeMapChange;
  x: number;
  y: number;
  color: string;
}): ReactElement {
  switch (change.state) {
    case 'ci-running':
      return (
        <g>
          <circle cx={x} cy={y} r={11} fill={color} opacity={0.25} className="code-map-pulse" />
          <circle cx={x} cy={y} r={5.5} fill={color} />
        </g>
      );
    case 'ci-failed':
      return (
        <g>
          <circle cx={x} cy={y} r={7.5} fill={color} />
          <path
            d={`M ${String(x - 3)} ${String(y - 3)} L ${String(x + 3)} ${String(y + 3)} M ${String(x + 3)} ${String(y - 3)} L ${String(x - 3)} ${String(y + 3)}`}
            stroke="var(--surface)"
            strokeWidth={1.8}
            strokeLinecap="round"
          />
        </g>
      );
    case 'ci-passed':
      return <circle cx={x} cy={y} r={5.5} fill={color} />;
    default:
      return (
        <path
          d={`M ${String(x - 8)} ${String(y - 5)} L ${String(x)} ${String(y)} L ${String(x - 8)} ${String(y + 5)}`}
          fill="none"
          stroke={color}
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );
  }
}

function EnvironmentLine({
  env,
  y,
  devY,
  now,
}: {
  env: CodeMapEnvironment;
  y: number;
  devY: number;
  now: number;
}): ReactElement {
  const live =
    env.sha === null
      ? 'live commit unknown'
      : env.since === null
        ? shortSha(env.sha)
        : `${shortSha(env.sha)} · live ${relativeTime(env.since, now).replace(' ago', '')}`;
  const behind =
    env.behind === 0 ? 'up to date' : `${String(env.behind)}${env.behindMore ? '+' : ''} behind`;
  const liveW = live.length * MONO_CHAR + 18;
  const behindW = behind.length * MONO_CHAR + 18;
  const pillX = END_X - liveW - behindW - 10;
  return (
    <g className="code-map-env" data-env={env.id}>
      <text x={LABEL_X} y={y + 4} className="code-map-label">
        {env.label}
      </text>
      <path
        d={`M ${String(TRUNK_X)} ${String(devY)} C ${String(TRUNK_X + 22)} ${String(devY)}, ${String(TRUNK_X + 14)} ${String(y)}, ${String(TRUNK_X + 44)} ${String(y)} L ${String(END_X)} ${String(y)}`}
        stroke={DEPLOYED_COLOR}
        strokeWidth={4}
        fill="none"
        strokeLinecap="round"
      />
      <rect x={pillX} y={y - 11} width={liveW} height={22} rx={11} fill={DEPLOYED_COLOR} />
      <text x={pillX + liveW / 2} y={y + 4} textAnchor="middle" className="code-map-pill">
        {live}
      </text>
      <rect
        x={pillX + liveW + 6}
        y={y - 11}
        width={behindW}
        height={22}
        rx={11}
        className="code-map-pill-quiet"
        stroke={env.behind === 0 ? DEPLOYED_COLOR : STATE_COLOR.merged}
      />
      <text
        x={pillX + liveW + 6 + behindW / 2}
        y={y + 4}
        textAnchor="middle"
        className="code-map-pill-text"
        fill={env.behind === 0 ? DEPLOYED_COLOR : STATE_COLOR.merged}
      >
        {behind}
      </text>
      {env.lastFailure !== null ? (
        <text x={END_X} y={y + 26} textAnchor="end" className="code-map-detail" fill="var(--error)">
          {`last deploy: ${env.lastFailure.label} · ${relativeTime(env.lastFailure.at, now)}`}
        </text>
      ) : null}
    </g>
  );
}

/**
 * The live code map (#348): a subway diagram of where every change is.
 *
 * The neutral trunk is the base branch. Above it, one line per change, in the
 * order it was opened, coloured by its state; a merged line drops back into
 * the trunk. Below it, one line per environment the code runs in, each with
 * its running commit and how many merged changes it does not have yet.
 *
 * Takes its data as props — a list of changes and a list of environments —
 * so a later issue adds an environment or an action without touching this.
 */
export function CodeMap({
  base,
  changes,
  environments,
  merging,
  renderEnvironmentAction,
  emptyText,
  now = Date.now(),
}: CodeMapProps): ReactElement {
  const devY = TOP + Math.max(changes.length, 1) * LANE + (changes.length === 0 ? 0 : 12);
  const envY = (k: number): number => devY + ENV_GAP * (k + 1);
  const height = (environments.length === 0 ? devY : envY(environments.length - 1)) + 40;

  return (
    <div className="flex flex-col gap-2">
      <div className="relative overflow-hidden rounded-lg border border-border bg-surface">
        <svg
          viewBox={`0 0 ${String(W)} ${String(height)}`}
          className="code-map block w-full"
          role="img"
          aria-label={`Live code map: ${String(changes.length)} change${changes.length === 1 ? '' : 's'} in flight`}
        >
          <text x={LABEL_X} y={devY + 4} className="code-map-label">
            {base ?? 'trunk'}
          </text>
          <line
            x1={TRUNK_X}
            y1={devY}
            x2={END_X}
            y2={devY}
            stroke={TRUNK_COLOR}
            strokeWidth={4}
            strokeLinecap="round"
          />
          {environments.map((env, k) => (
            <EnvironmentLine key={env.id} env={env} y={envY(k)} devY={devY} now={now} />
          ))}
          {changes.map((c, i) => (
            <Lane
              key={c.key}
              change={c}
              index={i}
              devY={devY}
              merging={merging?.has(c.key) === true}
              now={now}
            />
          ))}
          {changes.length === 0 && emptyText !== undefined ? (
            <text x={TRUNK_X + 40} y={TOP - 2} className="code-map-detail" fill={TRUNK_COLOR}>
              {emptyText}
            </text>
          ) : null}
        </svg>
        {renderEnvironmentAction !== undefined
          ? environments.map((env, k) => {
              const action = renderEnvironmentAction(env);
              if (action === null || action === undefined || action === false) return null;
              return (
                <div
                  key={env.id}
                  className="absolute -translate-x-1/2 -translate-y-1/2"
                  style={{
                    left: `${String(((TRUNK_X + 200) / W) * 100)}%`,
                    top: `${String(((devY + envY(k)) / 2 / height) * 100)}%`,
                  }}
                >
                  {action}
                </div>
              );
            })
          : null}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 px-1" aria-label="Line colours">
        {LEGEND.map(l => (
          <li key={l.label} className="flex items-center gap-1.5 text-mini text-text-tertiary">
            <span className="h-2 w-2 rounded-full" style={{ background: l.color }} />
            {l.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
