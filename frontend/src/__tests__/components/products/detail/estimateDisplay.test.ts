/**
 * How the side panel shows the estimate of one standard unit (WS-13 E9 B08, R06, R11).
 * The server's arithmetic is not repeated here: the table only chooses how to SHOW what
 * came back — a figure, «at least» a figure when part of the kit is not covered by the
 * plan, «—» when nothing is known, «no printing» for a real zero.
 */
import { describe, expect, it } from 'vitest';
import type { ProductEstimate } from '../../../../api/client';
import { estimateDisplay } from '../../../../components/products/detail/estimateDisplay';

function estimate(over: Partial<ProductEstimate>): ProductEstimate {
  return {
    prints: 2,
    print_time_seconds: 3600,
    filament_grams: 90,
    filament_cost: null,
    surplus: [],
    purchased_cost: null,
    purchased_known_cost: 0,
    purchased_partial: false,
    complete: true,
    reasons: [],
    ...over,
  };
}

describe('estimateDisplay', () => {
  it('a complete estimate is its figures', () => {
    expect(estimateDisplay(estimate({}))).toEqual({
      kind: 'figures',
      time: { kind: 'value', value: 3600 },
      grams: { kind: 'value', value: 90 },
      reasons: [],
    });
  });

  it('R11 (1) only no_plate: 0 g, time null, no prints, no unknown_weight — both unknown', () => {
    const shown = estimateDisplay(
      estimate({ prints: 0, print_time_seconds: null, filament_grams: 0, complete: false, reasons: [{ code: 'no_plate', count: 1 }] }),
    );
    expect(shown).toEqual({
      kind: 'figures',
      time: { kind: 'unknown' },
      grams: { kind: 'unknown' },
      reasons: [{ code: 'no_plate', count: 1 }],
    });
  });

  it('R11 (2) the same with needs_slicing', () => {
    const shown = estimateDisplay(
      estimate({ prints: 0, print_time_seconds: null, filament_grams: 0, complete: false, reasons: [{ code: 'needs_slicing', count: 2 }] }),
    );
    expect(shown.kind === 'figures' && shown.grams).toEqual({ kind: 'unknown' });
  });

  it('R11 (3) a coverage gap with a positive mass is a lower bound — time and mass', () => {
    const shown = estimateDisplay(estimate({ complete: false, reasons: [{ code: 'no_plate', count: 1 }] }));
    expect(shown).toMatchObject({ time: { kind: 'atLeast', value: 3600 }, grams: { kind: 'atLeast', value: 90 } });
  });

  it('R11 (4) unknown_weight with a zero mass is unknown; with a positive one, a lower bound', () => {
    expect(
      estimateDisplay(estimate({ filament_grams: 0, complete: false, reasons: [{ code: 'unknown_weight', count: 2 }] })),
    ).toMatchObject({ time: { kind: 'value', value: 3600 }, grams: { kind: 'unknown' } });
    expect(
      estimateDisplay(estimate({ complete: false, reasons: [{ code: 'unknown_weight', count: 1 }] })),
    ).toMatchObject({ grams: { kind: 'atLeast', value: 90 } });
  });

  it('R11 (5) only purchased parts — no printing, a real zero', () => {
    expect(estimateDisplay(estimate({ prints: 0, print_time_seconds: 0, filament_grams: 0 }))).toEqual({
      kind: 'noPrint',
      reasons: [],
    });
  });

  it('a zero beside a coverage gap is not «no printing» — the plan did not cover the kit', () => {
    expect(
      estimateDisplay(
        estimate({ prints: 0, print_time_seconds: 0, filament_grams: 0, complete: false, reasons: [{ code: 'truncated', count: null }] }),
      ),
    ).toMatchObject({ kind: 'figures', grams: { kind: 'unknown' } });
  });

  it('R11 (6) an unknown purchase price hides nothing and is not listed — there is no cost here', () => {
    expect(
      estimateDisplay(estimate({ complete: false, reasons: [{ code: 'unknown_purchase_price', count: 1 }] })),
    ).toEqual({ kind: 'figures', time: { kind: 'value', value: 3600 }, grams: { kind: 'value', value: 90 }, reasons: [] });
  });

  it('unknown_time: the time is unknown, the mass stands', () => {
    expect(
      estimateDisplay(estimate({ print_time_seconds: null, complete: false, reasons: [{ code: 'unknown_time', count: 1 }] })),
    ).toMatchObject({ time: { kind: 'unknown' }, grams: { kind: 'value', value: 90 } });
  });

  it('truncated is a coverage gap without a count', () => {
    const shown = estimateDisplay(estimate({ complete: false, reasons: [{ code: 'truncated', count: null }] }));
    expect(shown).toMatchObject({ time: { kind: 'atLeast' }, reasons: [{ code: 'truncated', count: null }] });
  });

  it('an empty composition is nothing to estimate — before every other rule', () => {
    expect(
      estimateDisplay(
        estimate({ prints: 0, print_time_seconds: 0, filament_grams: 0, complete: false, reasons: [{ code: 'empty_composition', count: null }] }),
      ),
    ).toEqual({ kind: 'empty', reasons: [{ code: 'empty_composition', count: null }] });
  });

  it('keeps the server’s order of the reasons it shows', () => {
    const shown = estimateDisplay(
      estimate({
        complete: false,
        reasons: [
          { code: 'no_plate', count: 1 },
          { code: 'unknown_time', count: 2 },
          { code: 'unknown_purchase_price', count: 1 },
          { code: 'truncated', count: null },
        ],
      }),
    );
    expect(shown.reasons.map((r) => r.code)).toEqual(['no_plate', 'unknown_time', 'truncated']);
  });
});
