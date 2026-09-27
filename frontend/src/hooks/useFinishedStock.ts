import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { InfiniteData } from '@tanstack/react-query';
import { api, STOCK_JOURNAL_PAGE } from '../api/client';
import type {
  StockItemDetail,
  StockItemsPage,
  StockItemsParams,
  StockItemsSummary,
  StockJournalPage,
  StockJournalParams,
  StockLookup,
} from '../api/client';

/**
 * The finished-goods questions (spec workshop-finished-goods, rules 16–21),
 * each declared ONCE — see `useStock.ts` for why a key is never spelled twice.
 * `invalidateStock` in `utils/queryInvalidation.ts` holds their prefixes.
 */
export function useStockItems(params: StockItemsParams) {
  return useQuery<StockItemsPage>({
    queryKey: ['stock-items', params],
    queryFn: () => api.getStockItems(params),
    placeholderData: keepPreviousData,
    retry: false,
    meta: { refreshToast: true },
  });
}

/** The finished-goods tiles — the whole farm, never the list's filters. */
export function useStockItemsSummary() {
  return useQuery<StockItemsSummary>({
    queryKey: ['stock-items', 'summary'],
    queryFn: () => api.getStockItemsSummary(),
    retry: false,
  });
}

export function useStockItem(id: number) {
  return useQuery<StockItemDetail>({
    queryKey: ['stock-item', id],
    queryFn: () => api.getStockItem(id),
    enabled: Number.isFinite(id) && id > 0,
    retry: false,
    meta: { refreshToast: true },
  });
}

/** A dialog's answer for a product and its options; asked only once a product is picked. */
export function useStockLookup(productId: number | null, options: number[]) {
  const sorted = [...options].sort((a, b) => a - b);
  return useQuery<StockLookup>({
    queryKey: ['stock-lookup', productId, sorted.join(',')],
    queryFn: () => api.lookupStockItem(productId as number, sorted),
    enabled: productId != null,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/** The journal's filters are everything but the cursor and the page size. */
export type StockJournalQuery = Omit<StockJournalParams, 'cursor' | 'limit'>;

export function useStockJournal(filters: StockJournalQuery) {
  return useInfiniteQuery<
    StockJournalPage,
    Error,
    InfiniteData<StockJournalPage, string | null>,
    unknown[],
    string | null
  >({
    queryKey: ['stock-journal', filters],
    queryFn: ({ pageParam }) => api.getStockJournal({ ...filters, cursor: pageParam, limit: STOCK_JOURNAL_PAGE }),
    initialPageParam: null,
    // A short page IS the end: the server sets `next_cursor` only on a full one.
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    retry: false,
    meta: { refreshToast: true },
  });
}
