import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../api/client';
import type { OrderForecast, OrderListItem } from '../../../api/client';
import type { ForecastState } from './readiness';

/**
 * The rows of a page a forecast is asked for (WS-13 E7 B04, R07): active, with
 * something ordered and something left to cover — the rest `readiness` answers
 * without one.
 */
export function forecastIdsFor(orders: Pick<OrderListItem, 'id' | 'status' | 'ordered' | 'remaining'>[]): number[] {
  return orders.filter((o) => o.status === 'active' && o.ordered > 0 && o.remaining > 0).map((o) => o.id);
}

/**
 * The forecast of a list page, in batches (WS-13 E7 B04).
 *
 * `api.getOrdersForecast` already sends one request per 200 ids (the endpoint's
 * limit), so a page needs exactly as many requests as batches — each one a walk of
 * `forecast_projects` on the server — and never one per row. A failed batch fails
 * the whole set (`Promise.all`), and `refetch` reads it again.
 */
export function useOrdersForecast(
  orders: Pick<OrderListItem, 'id' | 'status' | 'ordered' | 'remaining'>[],
  enabled: boolean,
): { state: ForecastState; byId: Record<number, OrderForecast>; refetch: () => Promise<unknown> } {
  const ids = useMemo(() => forecastIdsFor(orders), [orders]);
  const asks = enabled && ids.length > 0;
  const query = useQuery({
    queryKey: ['orders-forecast', ids],
    queryFn: () => api.getOrdersForecast(ids),
    enabled: asks,
    staleTime: 30_000,
  });
  const byId = useMemo(
    () => Object.fromEntries((query.data?.orders ?? []).map((f) => [f.project_id, f])) as Record<number, OrderForecast>,
    [query.data],
  );
  const state: ForecastState = !asks ? 'idle' : query.isError ? 'error' : query.data ? 'data' : 'loading';
  return { state, byId, refetch: () => query.refetch() };
}
