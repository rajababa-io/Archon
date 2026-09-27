import type { ReactElement, ReactNode } from 'react';

/**
 * Shared form primitives for the console settings panels (ModelTiersPanel,
 * AliasesPanel, AssistantConfigPanel, ChatsPanel, AgentCredentialCard,
 * ModelPickerField).
 *
 * Design v5 (.set-input / .set-select): mono fields on the page surface with a
 * magenta focus ring. Tokens only — colors come from the console theme vars.
 */

/** Free-text field (design v5 .set-input). */
export const INPUT_CLASS =
  'w-full rounded-lg border border-border bg-surface px-2.75 py-[7px] text-body text-text-primary placeholder:text-text-tertiary transition-all focus:border-accent-bright/50 focus:outline-none focus:shadow-[0_0_0_3px_color-mix(in_oklch,var(--accent),transparent_92%)]';

/** Row-sized select (tier/alias provider + effort selects). */
export const SELECT_CLASS =
  'w-full cursor-pointer appearance-none rounded-lg border border-border bg-surface-elevated py-[7px] pl-2.75 pr-6.25 text-body font-medium text-text-primary transition-all focus:border-accent-bright/50 focus:outline-none focus:shadow-[0_0_0_3px_color-mix(in_oklch,var(--accent),transparent_92%)]';

/**
 * Compact select base — the Defaults panel's codex effort / web-search options
 * use it as-is; its assistant/provider pickers reuse it with size overrides
 * (`py-[7px] pl-2.75 text-body`) appended.
 */
export const SELECT_CLASS_COMPACT =
  'w-full cursor-pointer appearance-none rounded-lg border border-border bg-surface-elevated py-[7px] pl-3 pr-6.25 text-body font-medium text-text-primary transition-all focus:border-accent-bright/50 focus:outline-none focus:shadow-[0_0_0_3px_color-mix(in_oklch,var(--accent),transparent_92%)]';

/**
 * Relative wrapper that overlays the design chevron on an appearance-none
 * select (.set-select / .set-select-chev — the browser's edge-pinned arrow is
 * killed by appearance-none; this paints the design's chevron at right:11px).
 */
export function SelectShell({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}): ReactElement {
  return (
    <span className={`relative inline-flex items-center ${className}`}>
      {children}
      <span
        aria-hidden
        className="pointer-events-none absolute right-[11px] flex text-text-tertiary"
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </span>
    </span>
  );
}

/**
 * The design's pill switch (`.sw` in the settings mockup), as a real control.
 *
 * A `button` with `role="switch"`, not a styled `div`: the mockup's version is
 * a div with an `aria-checked` attribute and a click listener, which is
 * unreachable by keyboard and invisible to a screen reader as a control. The
 * appearance is the part worth copying.
 */
export function Switch({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}): ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => {
        onChange(!checked);
      }}
      className="relative h-[22px] w-[38px] shrink-0 rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-40"
      // Inline because the console scope's wildcard border-color rule repaints
      // Tailwind border utilities (see theme.css).
      style={{
        background: checked ? 'var(--accent)' : 'var(--surface-bright, var(--surface-hover))',
        borderColor: checked ? 'var(--accent)' : 'var(--border-bright)',
      }}
    >
      <span
        aria-hidden
        className="absolute top-[2px] h-[16px] w-[16px] rounded-full transition-all"
        style={{
          left: checked ? '18px' : '2px',
          background: checked ? 'oklch(.99 0 0)' : 'var(--text-secondary)',
        }}
      />
    </button>
  );
}
