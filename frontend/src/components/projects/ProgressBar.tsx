interface ProgressBarProps {
  value: number;
  max: number;
  /** Server-calculated fraction, when `value / max` has a different meaning. */
  progress?: number;
  label?: string;
  /** The caption on the right: `value / max` (the default) or the percentage — of the
   *  server's `progress` when given, rounded DOWN, so 99.99 % never reads «100%».
   *  `both` (WS-13 E7 B02): `label value / max` on the left, the percentage on the right.
   *  `none` (WS-13 E11 E04): the bar alone, under a figure that already says the numbers. */
  caption?: 'ratio' | 'percent' | 'both' | 'none';
  testId?: string;
}

/**
 * Progress as the server counted it.
 *
 * Renders nothing when there is nothing to count against — the `{0 && <jsx>}`
 * stray-zero bug lived exactly here, so the gate is an explicit `<= 0` return
 * and never a `&&` on a number. The `value / max` caption is rendered ONLY
 * inside this component: a caller that prints its own numbers beside the bar is
 * the second source of truth this component exists to remove.
 */
/** A fraction as a whole percent rounded DOWN — with an epsilon, because 0.29 × 100 is 28.999… in floating point. */
function percentDown(fraction: number): number {
  return Math.min(100, Math.max(0, Math.floor(fraction * 100 + 1e-9)));
}

export function ProgressBar({ value, max, progress, label, caption = 'ratio', testId = 'progress' }: ProgressBarProps) {
  if (max <= 0) return null;
  // Keep the server's fractional result exact.  Rounding 0.9999 to 100 would
  // make an unfinished order look complete, even though its caption says so.
  const pct = progress == null
    ? Math.min(100, Math.round((value / max) * 100))
    : Math.min(100, Math.max(0, progress * 100));
  return (
    <div data-testid={testId} className="space-y-1">
      {caption !== 'none' && (
      <div className="flex items-center justify-between gap-2 text-xs text-bambu-gray">
        {caption === 'both' ? (
          <span className="tabular-nums">{label ? `${label} ${value} / ${max}` : `${value} / ${max}`}</span>
        ) : label ? (
          <span>{label}</span>
        ) : (
          <span />
        )}
        <span className="tabular-nums">
          {caption === 'ratio'
            ? `${value} / ${max}`
            : // The server rounds its fraction: a big order one unit short can arrive as 1.0.
              `${value < max ? Math.min(99, percentDown(progress ?? value / max)) : percentDown(progress ?? value / max)}%`}
        </span>
      </div>
      )}
      <div className="h-2 rounded-full bg-bambu-dark-tertiary overflow-hidden">
        <div
          data-testid={`${testId}-fill`}
          className="h-full bg-bambu-green transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
