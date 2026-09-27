/**
 * The resolved chat-handoff thresholds, with their defaults applied.
 *
 * A separate resolver rather than `?? 40` at each call site: the same three
 * numbers are read by the thing that nudges and the thing that acts, and two
 * defaults that must agree by discipline are already a defect.
 */
import type { ChatsConfig } from './config-types';

export interface ResolvedChatsConfig {
  /** Fill fraction at which wrapping up is suggested. */
  nudgeAt: number;
  /** Fill fraction at which a handoff happens, at the next safe boundary. */
  handoffAt: number;
  /** Whether crossing `handoffAt` acts, or only reports. */
  autoHandoff: boolean;
  /** Whether a finished turn gets a suggested next message. */
  suggestNextMessage: boolean;
  /**
   * The same two thresholds as whole percentages.
   *
   * Both representations because both are read: the nudge divides a token
   * count and wants a fraction, while the config file and the settings editor
   * speak in percent. Derived here rather than converted back at the reader —
   * `0.4 * 100` is not 40 in floating point, and a settings field that shows
   * `40.00000000000001` is the kind of defect nobody thinks to look for.
   */
  nudgeAtPercent: number;
  handoffAtPercent: number;
  /** Minutes on "Waiting on CI" before the console calls the wait overdue. */
  ciWaitAlarmMinutes: number;
}

const DEFAULT_NUDGE_PERCENT = 40;
const DEFAULT_HANDOFF_PERCENT = 50;
/**
 * First-attempt CI on this repository finished within 14 minutes across 216
 * runs (#196); every longer one was a rerun. Twenty clears the slowest real
 * run without leaving a stuck wait unremarked for long.
 */
const DEFAULT_CI_WAIT_ALARM_MINUTES = 20;
/**
 * The watch itself gives up at 24 hours (`CI_WATCH_MAX_AGE_MS`), so an alarm
 * later than that could never show.
 */
export const MAX_CI_WAIT_ALARM_MINUTES = 24 * 60;

/**
 * Percentages become fractions here, and nonsense becomes the default.
 *
 * A percentage outside 1–99 is not a stricter policy, it is a typo: zero would
 * hand off on the first turn and 100 could never fire at all. Both are
 * silently useless in a way the operator would not discover for days, so a
 * value that cannot be meant is refused rather than honoured.
 *
 * A nudge above the handoff point is also refused — it would announce a
 * suggestion the system had already acted on.
 */
export function resolveChatsConfig(config: ChatsConfig | undefined): ResolvedChatsConfig {
  const handoffPercent = usable(config?.handoffAtPercent) ?? DEFAULT_HANDOFF_PERCENT;
  const nudgeRaw = usable(config?.nudgeAtPercent) ?? DEFAULT_NUDGE_PERCENT;
  const nudgePercent = nudgeRaw < handoffPercent ? nudgeRaw : DEFAULT_NUDGE_PERCENT;

  return {
    nudgeAt: nudgePercent / 100,
    handoffAt: handoffPercent / 100,
    autoHandoff: config?.autoHandoff ?? true,
    suggestNextMessage: config?.suggestNextMessage ?? true,
    nudgeAtPercent: nudgePercent,
    handoffAtPercent: handoffPercent,
    ciWaitAlarmMinutes: usableMinutes(config?.ciWaitAlarmMinutes) ?? DEFAULT_CI_WAIT_ALARM_MINUTES,
  };
}

function usableMinutes(minutes: number | undefined): number | undefined {
  if (minutes === undefined || !Number.isInteger(minutes)) return undefined;
  if (minutes < 1 || minutes > MAX_CI_WAIT_ALARM_MINUTES) return undefined;
  return minutes;
}

function usable(percent: number | undefined): number | undefined {
  if (percent === undefined || !Number.isFinite(percent)) return undefined;
  if (percent < 1 || percent > 99) return undefined;
  return percent;
}
