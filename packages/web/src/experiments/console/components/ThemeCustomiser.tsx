import { type ReactElement } from 'react';
import { setAppearance } from '../../../theme/appearance';
import { contrastRatio, parseHex } from '../../../theme/color';
import { AA, generateTheme, type ThemeInput } from '../../../theme/generate';

/**
 * The three inputs a custom theme is generated from, plus an honest readout of
 * what the generator did with them.
 *
 * The readout exists because the clamp is silent by design: an accent that
 * cannot be read as text is lifted rather than refused, so without this the
 * user sees a colour they did not pick and has no way to learn why. Naming the
 * measured ratio turns a surprise into an explanation.
 */
export function ThemeCustomiser({ value }: { value: ThemeInput }): ReactElement {
  const set = (patch: Partial<ThemeInput>): void => {
    setAppearance({ custom: { ...value, ...patch } });
  };
  const tokens = generateTheme(value);
  const surfaceHover = parseHex(tokens['surface-hover']);
  const accentRgb = parseHex(value.accent);
  const brightRgb = parseHex(tokens['accent-bright']);
  // Only claim a lift happened when the accent is a colour at all; a
  // half-typed hex should read as nothing to report, not as a failure.
  const rawRatio =
    accentRgb !== null && surfaceHover !== null ? contrastRatio(accentRgb, surfaceHover) : null;
  const lifted = rawRatio !== null && rawRatio < AA;

  return (
    <div className="flex flex-col gap-x-2.25 gap-y-1.75 border-t border-border py-2.25 pl-3">
      <ColorField
        label="Accent"
        hint="Used as a fill exactly as picked. Text derived from it is lifted to stay readable."
        value={value.accent}
        onChange={accent => {
          set({ accent });
        }}
      />
      <ColorField
        label="Background"
        hint="Decides light or dark. There is no separate mode setting."
        value={value.background}
        onChange={background => {
          set({ background });
        }}
      />
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-body font-medium text-text-primary">Contrast</div>
          <div className="mt-0.5 text-small text-text-tertiary">
            Spreads the surfaces apart. Text stays at {AA}:1 whatever this says.
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            aria-label="Contrast"
            value={value.contrast}
            onChange={e => {
              set({ contrast: Number(e.target.value) });
            }}
            className="w-[160px] accent-[color:var(--accent)]"
          />
          <span className="w-7 text-right text-small text-text-secondary tabular-nums">
            {value.contrast}
          </span>
        </div>
      </div>
      <p className="text-small leading-relaxed text-text-tertiary">
        {lifted && brightRgb !== null && surfaceHover !== null ? (
          <>
            Your accent reads at <span className="text-warning">{rawRatio.toFixed(2)}:1</span> as
            text, below the {AA}:1 floor, so labels use{' '}
            <span style={{ color: tokens['accent-bright'] }}>{tokens['accent-bright']}</span> at{' '}
            <span className="text-success">
              {contrastRatio(brightRgb, surfaceHover).toFixed(2)}:1
            </span>
            . Fills keep the colour you chose.
          </>
        ) : (
          <>
            Your accent reads at{' '}
            <span className="text-success">{rawRatio?.toFixed(2) ?? '—'}:1</span> as text. No lift
            needed.
          </>
        )}
      </p>
    </div>
  );
}

/**
 * A hex field beside a native colour well. Both edit the same value: the well
 * is how you explore, the text is how you paste a brand colour you already have.
 */
function ColorField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (next: string) => void;
}): ReactElement {
  const valid = parseHex(value) !== null;
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-body font-medium text-text-primary">{label}</div>
        <div className="mt-0.5 text-small text-text-tertiary">{hint}</div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <input
          type="color"
          aria-label={`${label} colour`}
          value={valid ? value : '#000000'}
          onChange={e => {
            onChange(e.target.value.toUpperCase());
          }}
          className="h-[26px] w-[34px] cursor-pointer rounded-[6px] border border-border bg-transparent p-0"
        />
        <input
          type="text"
          aria-label={`${label} hex`}
          value={value}
          spellCheck={false}
          onChange={e => {
            onChange(e.target.value.toUpperCase());
          }}
          className="w-[92px] rounded-[8px] border bg-surface-inset px-2 py-1 text-small text-text-primary"
          // Invalid mid-typing is normal, so it is marked rather than rejected:
          // the generator falls back and the app keeps rendering.
          style={{ borderColor: valid ? 'var(--border)' : 'var(--warning)' }}
        />
      </div>
    </div>
  );
}
