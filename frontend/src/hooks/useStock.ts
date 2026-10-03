import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { StockFigures, StockListPage, StockListParams } from '../api/client';

/**
 * The free-parts tab's two questions, each declared ONCE (the journal of both
 * ledgers lives in `useFinishedStock.ts`).
 *
 * TanStack keeps one set of options per query key and the last observer to
 * mount owns them (`hooks/detailQueryKeys.test.ts` polices the detail keys for
 * this reason), so the page and any future widget go through these functions
 * rather than spelling the keys themselves.
 *
 * `retry: false` — each degrades to "could not load" and can act on nothing
 * else. No `refreshToast`: the tab keeps its rows when a background refetch
 * fails and says so beside them (`RefreshFailedNote`, WS-13 E12 B04) — a toast
 * as well would say it twice.
 */
export function useStockPage(params: StockListParams) {
  return useQuery<StockListPage>({
    queryKey: ['stock-summary', params],
    queryFn: () => api.getStockPaged(params),
    // The old page stays on screen while the next one loads — no spinner flash.
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/** The shelf tiles — under the `stock-summary` prefix, so every invalidation of the list reaches them. */
export function useStockFigures() {
  return useQuery<StockFigures>({
    queryKey: ['stock-summary', 'figures'],
    queryFn: () => api.getStockFigures(),
    retry: false,
  });
}
