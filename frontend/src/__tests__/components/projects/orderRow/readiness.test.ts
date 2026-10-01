import { describe, it, expect } from 'vitest';
import type { OrderForecast } from '../../../../api/client';
import { readiness } from '../../../../components/projects/orderRow/readiness';
import { FORECAST_DEFAULTS } from '../../../wireDefaults';

const order = (over: Partial<{ status: 'active' | 'completed' | 'cancelled'; ordered: number; remaining: number }> = {}) => ({
  status: 'active' as const,
  ordered: 10,
  remaining: 6,
  ...over,
});

const fc = (over: Partial<OrderForecast> = {}): OrderForecast => ({
  ...FORECAST_DEFAULTS,
  project_id: 1,
  now_eta: '2026-10-06T09:00:00Z',
  now_seconds: 3600,
  after_eta: null,
  after_seconds: null,
  machine_seconds: 3600,
  unknown_prints: 0,
  unroutable_prints: 0,
  eta_complete: true,
  ahead_count: 0,
  assumptions: [],
  ...over,
});

// WS-13 E7 B03: one rule, in this order — the list's «Ready ≈» for every view.
describe('readiness', () => {
  it('says nothing for an order nothing is planned for', () => {
    expect(readiness(order({ status: 'completed' }), fc(), 'data')).toEqual({ kind: 'closed' });
    expect(readiness(order({ status: 'cancelled' }), undefined, 'idle')).toEqual({ kind: 'closed' });
    expect(readiness(order({ ordered: 0, remaining: 0 }), undefined, 'idle')).toEqual({ kind: 'closed' });
  });

  it('calls an order with nothing left to cover covered, without a forecast', () => {
    expect(readiness(order({ remaining: 0 }), undefined, 'idle')).toEqual({ kind: 'covered' });
  });

  it('waits while the forecast is read and fails when it could not be', () => {
    expect(readiness(order(), undefined, 'loading')).toEqual({ kind: 'loading' });
    expect(readiness(order(), undefined, 'error')).toEqual({ kind: 'error' });
  });

  it('shows no date while the simulation is incomplete — the ready sort does not take one', () => {
    const reasons = [{ code: 'unknown_time', count: 2 }];
    expect(readiness(order(), fc({ eta_complete: false, incomplete_reasons: reasons }), 'data')).toEqual({
      kind: 'partial',
      reasons,
    });
  });

  it('names a missing date «no estimate» only when there are no reasons', () => {
    expect(readiness(order(), fc({ now_eta: null }), 'data')).toEqual({ kind: 'none' });
    const reasons = [{ code: 'no_plate', count: 3 }];
    expect(readiness(order(), fc({ now_eta: null, incomplete_reasons: reasons }), 'data')).toEqual({
      kind: 'partial',
      reasons,
    });
  });

  it('keeps an admitted date beside the reasons that make the estimate partial (R01)', () => {
    const reasons = [{ code: 'no_plate', count: 6 }];
    expect(readiness(order(), fc({ incomplete_reasons: reasons, late: true }), 'data')).toEqual({
      kind: 'eta',
      eta: '2026-10-06T09:00:00Z',
      late: true,
      after: null,
      reasons,
    });
  });

  it('adds «after N more urgent» only when the queue moves the date', () => {
    const later = readiness(order(), fc({ after_eta: '2026-10-08T09:00:00Z', ahead_count: 2 }), 'data');
    expect(later).toMatchObject({ kind: 'eta', after: { eta: '2026-10-08T09:00:00Z', ahead: 2 } });
    expect(readiness(order(), fc({ after_eta: '2026-10-06T09:00:00Z', ahead_count: 2 }), 'data')).toMatchObject({ after: null });
    expect(readiness(order(), fc({ after_eta: '2026-10-08T09:00:00Z', ahead_count: 0 }), 'data')).toMatchObject({ after: null });
  });
});
