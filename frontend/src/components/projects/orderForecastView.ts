import type { OrderForecastDetail } from '../../api/client';

/**
 * What the order page may say about its forecast right now (WS-13 E3 E04 / G02).
 * One decision for the «Ready ≈» tile and the forecast panel, so the two never
 * tell different stories.
 *
 * ⚠️ **An edited plan outranks every number** (R03): the server forecast
 * describes the plan as it is stored, not the counts the operator has typed and
 * not yet sent, so while the plan has a draft nothing numeric is shown. The same
 * holds after a successful send (`sentAt`) until the forecast is read again: the
 * cached answer is the previous plan's. A re-read that FAILS after the send is
 * an error with a retry — judged by the query's own `errorUpdatedAt`, so it can
 * never leave the tile and the panel on «loading» for ever (review 1).
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
  sentAt,
  dataUpdatedAt,
  errorUpdatedAt,
  data,
  isError,
}: {
  active: boolean;
  draft: boolean;
  /** When the plan was last sent from this page (ms), or null. */
  sentAt: number | null;
  /** The forecast query's own clocks (TanStack `dataUpdatedAt` / `errorUpdatedAt`, ms). */
  dataUpdatedAt: number;
  errorUpdatedAt: number;
  data: OrderForecastDetail | undefined;
  isError: boolean;
}): ForecastView {
  if (!active) return { kind: 'closed' };
  if (draft) return { kind: 'draft' };
  if (sentAt != null && dataUpdatedAt < sentAt) {
    // The cached answer is the previous plan's: wait for the re-read, or fail with it.
    return errorUpdatedAt >= sentAt ? { kind: 'error' } : { kind: 'loading' };
  }
  if (data) return { kind: 'data', forecast: data, refreshFailed: isError };
  return isError ? { kind: 'error' } : { kind: 'loading' };
}
