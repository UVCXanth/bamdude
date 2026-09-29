import type { OrderForecastDetail } from '../../api/client';

/**
 * What the order page may say about its forecast right now (WS-13 E3 E04 / G02).
 * One decision for the «Ready ≈» tile and the forecast panel, so the two never
 * tell different stories.
 *
 * ⚠️ **An edited plan outranks every number** (R03): the server forecast
 * describes the plan as it is stored, not the counts the operator has typed and
 * not yet sent, so while the plan has a draft nothing numeric is shown. The same
 * holds between a successful send and the fresh forecast (`refreshing`): the
 * cached answer is the previous plan's.
 */
export type ForecastView =
  | { kind: 'closed' }
  | { kind: 'draft' }
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'data'; forecast: OrderForecastDetail; refreshFailed: boolean };

export function forecastView({
  active,
  draft,
  refreshing,
  data,
  isError,
}: {
  active: boolean;
  draft: boolean;
  refreshing: boolean;
  data: OrderForecastDetail | undefined;
  isError: boolean;
}): ForecastView {
  if (!active) return { kind: 'closed' };
  if (draft) return { kind: 'draft' };
  if (refreshing) return { kind: 'loading' };
  if (data) return { kind: 'data', forecast: data, refreshFailed: isError };
  return isError ? { kind: 'error' } : { kind: 'loading' };
}
