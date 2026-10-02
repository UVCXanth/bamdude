import type { EstimateReason, ProductEstimate } from '../../../api/client';

/** Part of the kit the plan did not cover: what is known is a lower bound (E9-B08). */
const COVERAGE_GAP = new Set(['no_plate', 'needs_slicing', 'truncated']);

/** The reasons that speak about time and mass — `unknown_purchase_price` is about a cost
 *  this fact does not show (K11). */
const SHOWN = new Set(['no_plate', 'needs_slicing', 'unknown_time', 'unknown_weight', 'truncated', 'empty_composition']);

export type EstimateFigure = { kind: 'value'; value: number } | { kind: 'atLeast'; value: number } | { kind: 'unknown' };

export type EstimateShown =
  | { kind: 'empty'; reasons: EstimateReason[] }
  | { kind: 'noPrint'; reasons: EstimateReason[] }
  | { kind: 'figures'; time: EstimateFigure; grams: EstimateFigure; reasons: EstimateReason[] };

/**
 * How the side panel shows the estimate of one standard unit (WS-13 E9 B08, R06, R11).
 *
 * The server's arithmetic is not repeated: this only chooses how to SHOW what came back.
 * An empty composition is nothing to estimate; a real zero (only purchased parts) is «no
 * printing», never «—». Otherwise each figure is itself, «at least» itself when part of
 * the kit is not covered by the plan, or unknown: a time the server did not know, and a
 * mass of 0 g that only says no positive estimate is known — a part without a plate adds
 * 0 g and `no_plate` without `unknown_weight`, because it has no plan rows (R11).
 */
export function estimateDisplay(estimate: ProductEstimate): EstimateShown {
  const codes = new Set(estimate.reasons.map((r) => r.code));
  const reasons = estimate.reasons.filter((r) => SHOWN.has(r.code));
  if (codes.has('empty_composition')) return { kind: 'empty', reasons };
  const gap = [...codes].some((code) => COVERAGE_GAP.has(code));
  if (estimate.prints === 0 && estimate.print_time_seconds === 0 && !gap) return { kind: 'noPrint', reasons };

  const time: EstimateFigure =
    estimate.print_time_seconds == null
      ? { kind: 'unknown' }
      : { kind: gap ? 'atLeast' : 'value', value: estimate.print_time_seconds };
  const doubtful = gap || codes.has('unknown_weight');
  const grams: EstimateFigure = !doubtful
    ? { kind: 'value', value: estimate.filament_grams }
    : estimate.filament_grams > 0
      ? { kind: 'atLeast', value: estimate.filament_grams }
      : { kind: 'unknown' };
  return { kind: 'figures', time, grams, reasons };
}
