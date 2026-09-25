import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { InfiniteData } from '@tanstack/react-query';
import { api, STOCK_JOURNAL_PAGE } from '../api/client';
import type { StockFigures, StockListPage, StockListParams, StockMovementsPage, StockMovementsParams } from '../api/client';

/**
 * The Stock tab's three questions, each declared ONCE.
 *
 * TanStack keeps one set of options per query key and the last observer to
 * mount owns them (`hooks/detailQueryKeys.test.ts` polices the detail keys for
 * this reason), so the page and any future widget go through these functions
 * rather than spelling the keys themselves.
 *
 * `retry: false` — each degrades to "could not load" and can act on nothing
 * else. `meta: { refreshToast: true }` — with data on screen a failed
 * background refetch keeps it and says so once, the rule the detail pages
 * follow.
 */
export function useStockPage(params: StockListParams) {
  return useQuery<StockListPage>({
    queryKey: ['stock-summary', params],
    queryFn: () => api.getStockPaged(params),
    // The old page stays on screen while the next one loads — no spinner flash.
    placeholderData: keepPreviousData,
    retry: false,
    meta: { refreshToast: true },
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

/** The journal filters are everything but the cursor and the page size. */
export type StockJournalFilters = Pick<StockMovementsParams, 'product_id' | 'part_id' | 'reason'>;

export function useStockMovements(filters: StockJournalFilters) {
  return useInfiniteQuery<
    StockMovementsPage,
    Error,
    InfiniteData<StockMovementsPage, number | null>,
    unknown[],
    number | null
  >({
    queryKey: ['stock-movements', filters],
    queryFn: ({ pageParam }) =>
      api.getStockMovements({ ...filters, before_id: pageParam, limit: STOCK_JOURNAL_PAGE }),
    initialPageParam: null,
    // A short page IS the end: the server sets `next_before_id` only on a
    // full one, and `undefined` tells TanStack there is no next page.
    getNextPageParam: (last) => last.next_before_id ?? undefined,
    retry: false,
    meta: { refreshToast: true },
  });
}
