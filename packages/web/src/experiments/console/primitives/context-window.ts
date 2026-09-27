/**
 * How full a chat's context is, and whether that can honestly be said at all.
 *
 * The reading is gross input on the LAST REQUEST of the last turn — not the
 * turn's total, which sums every request and runs to millions on a tool-heavy
 * turn. Turning it into a PERCENTAGE needs the window of the model that
 * answered, resolved SERVER-SIDE and written alongside the reading (see
 * core/orchestrator/context-window.ts). This file divides; it looks nothing up.
 *
 * That split is the point. A second table here would be a second opinion about
 * how full a conversation is, and the two would drift the first time either
 * was edited. Where the server could not name a window, there is no
 * percentage — the bar shows the raw figure and claims nothing. A guessed
 * denominator would be believed, and it decides when a chat gets abandoned.
 */

/**
 * Where the reading changes colour, and the one place that decides it.
 *
 * Owned here rather than in whichever component happens to draw it, because
 * two surfaces now wear the same number — the strip under the chat and the
 * row in the rail — and a second copy of these thresholds would be a second
 * opinion about when to worry. Destined to become a user setting; when it
 * does, this is the seam that reads it.
 *
 * Amber is "think about wrapping up", red is "do it". Red sits at 60 rather
 * than higher so the band that says act is long enough to act in: on a 1M
 * window that is 400k of runway instead of 250k.
 */
export const AMBER_AT = 0.4;
export const RED_AT = 0.6;

/** The token for a fraction, or the quiet one when no percentage is claimed. */
export function occupancyTone(fraction: number | null): string {
  if (fraction === null) return 'var(--text-tertiary)';
  if (fraction >= RED_AT) return 'var(--error)';
  if (fraction >= AMBER_AT) return 'var(--warning-mark)';
  return 'var(--text-tertiary)';
}

/**
 * The percentage a reader sees: a whole number, never rounded down to hide.
 *
 * Deliberately uncapped. A percentage capped at 100 lets a wrong denominator
 * pass as merely full — this once read 100% for a conversation at 283% of the
 * window it had been given.
 */
export function occupancyPercent(fraction: number): number {
  return Math.round(fraction * 100);
}

export interface ContextReading {
  /** How full the context was when the last turn ended. */
  tokens: number;
  /** The model's window — the denominator — or null when it is not known. */
  window: number | null;
  /** Fraction of that window, or null when the server named no window. */
  fraction: number | null;
  /** The model that answered, as the provider named it. */
  model: string | null;
}

/**
 * The newest turn that reported a reading.
 *
 * Occupancy is the NEWEST value, never a sum: it describes the prefix replayed
 * on the last request, and it FALLS when the provider compacts — which is the only
 * visible sign compaction happened.
 */
export function contextReading(
  messages: readonly {
    usage: {
      context?: number;
      input: number;
      costUsd: number | null;
      window?: number;
      model?: string;
    } | null;
  }[]
): ContextReading | null {
  let newest: { tokens: number; window: number | null; model: string | null } | null = null;

  for (const m of messages) {
    if (m.usage === null) continue;
    // `context` only. `input` is the turn's TOTAL — every request summed — so
    // a tool-heavy turn reports millions against a 200k window. A reading
    // written before that distinction existed is skipped for occupancy rather
    // than shown as 6600% full.
    if (m.usage.context !== undefined) {
      newest = {
        tokens: m.usage.context,
        window: m.usage.window ?? null,
        model: m.usage.model ?? null,
      };
    }
  }
  if (newest === null) return null;

  return {
    tokens: newest.tokens,
    window: newest.window,
    fraction: newest.window === null ? null : newest.tokens / newest.window,
    model: newest.model,
  };
}

/** What the chat's turns ran on and what they cost, as the status line shows it. */
export interface TurnFacts {
  /** The model the newest reporting turn ran on; null when it named none. */
  model: string | null;
  /** The effort that turn was handed; null when it was left to the provider's default. */
  effort: string | null;
  /** Every reported turn's cost, summed; null when no turn reported one. */
  costUsd: number | null;
}

/**
 * Model and effort from the NEWEST turn that reported usage, cost summed over all.
 *
 * Kept apart from `contextReading` because none of these needs an occupancy
 * figure: a Codex turn reports token totals but no per-request context, and
 * its model and effort are still facts worth showing.
 *
 * Model and effort come from the one newest turn and are never filled in from
 * an older one. A turn that named no effort ran on the provider's default, and
 * carrying the previous turn's rung forward would show a setting the chat no
 * longer uses.
 */
export function turnFacts(
  messages: readonly {
    usage: { costUsd: number | null; model?: string; effort?: string } | null;
  }[]
): TurnFacts | null {
  let newest: { model?: string; effort?: string } | null = null;
  let cost = 0;
  let sawCost = false;
  for (const m of messages) {
    if (m.usage === null) continue;
    newest = m.usage;
    if (m.usage.costUsd !== null) {
      cost += m.usage.costUsd;
      sawCost = true;
    }
  }
  if (newest === null) return null;
  return {
    model: newest.model ?? null,
    effort: newest.effort ?? null,
    costUsd: sawCost ? cost : null,
  };
}

/**
 * `$4.12`, `<$0.01` — never `$0.00`. A turn that reported a cost cost
 * something, and a zero on screen reads as "free" or "not reported".
 */
export function formatCost(usd: number): string {
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

/**
 * `claude-opus-5-20260101` → `opus-5`. The vendor prefix and the build date
 * are the same on every model in a fleet, so they cost width and say nothing.
 * The full id stays in the tooltip.
 */
export function shortModel(model: string): string {
  return model
    .replace(/^(anthropic|openai|google|claude|gpt|gemini)[-/]/i, m =>
      /^(gpt|gemini)/i.test(m) ? m : ''
    )
    .replace(/-\d{8}$/, '');
}

/**
 * `163k`, `1M`, `1.2M`, `840` — a token count at a glance.
 *
 * Lower-case `k`, upper-case `M`: those are the SI prefixes for a thousand and
 * a million, and an upper-case K is kelvin.
 *
 * A trailing `.0` is dropped. `1.0M` spends a character to say nothing — the
 * window it usually labels is exactly a million — while `1.2M` still needs its
 * decimal, because rounding it to `1M` would be a fifth of the window lost in
 * the rendering.
 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    const millions = (n / 1_000_000).toFixed(1);
    return `${millions.endsWith('.0') ? millions.slice(0, -2) : millions}M`;
  }
  if (n >= 1_000) return `${Math.round(n / 1_000).toString()}k`;
  return n.toString();
}
