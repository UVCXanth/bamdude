import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type {
  StockItemDetail,
  StockItemsPage,
  StockItemsParams,
  StockItemsSummary,
  StockJournalBook,
  StockJournalPage,
  StockJournalProduct,
  StockLookup,
} from '../api/client';

/**
 * The finished-goods questions (spec workshop-finished-goods, rules 16–21),
 * each declared ONCE — see `useStock.ts` for why a key is never spelled twice.
 * `invalidateStock` in `utils/queryInvalidation.ts` holds their prefixes.
 */
/**
 * A page of finished-goods positions. `refreshToast: false` is for a list that says a failed
 * re-read itself, beside its rows (the stock page's `RefreshFailedNote`, WS-13 E12 B04) — a
 * toast as well would say it twice. Keys differ per caller's params, so the two never share
 * one query's `meta`.
 */
export function useStockItems(params: StockItemsParams, { refreshToast = true }: { refreshToast?: boolean } = {}) {
  return useQuery<StockItemsPage>({
    queryKey: ['stock-items', params],
    queryFn: () => api.getStockItems(params),
    placeholderData: keepPreviousData,
    retry: false,
    ...(refreshToast ? { meta: { refreshToast: true } } : {}),
  });
}

/**
 * Every position of ONE product, unpaged (WS-13 E9 B09 / F01): the side panel's breakdown
 * and the «Stock» tab's table ask the same question, and one params object keeps them on
 * one key — one request, one cache entry, one refresh.
 */
export function productPositionsParams(productId: number): StockItemsParams {
  return { product_id: productId, mode: 'all', all: true };
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

/** A numbered page of the journal (WS-13 E1 ST1): the stock page's tab, a position's feed
 *  (`item_id`) and one product's (`product_id`, WS-13 E9 F03). */
export interface StockJournalPageParams {
  book: StockJournalBook;
  product_id?: number;
  item_id?: number;
  kind?: string;
  page: number;
  per_page: number;
  sort_by: 'date-desc' | 'date-asc';
}

/**
 * Every journal of the app — the stock page's tab, a position's, a product's — reads the
 * server's numbered pages (`page` mode) as a plain query under `['stock-journal-page',
 * params]`; the cursor mode stays in the API for other readers (WS-13 E12 E01).
 *
 * The previous page stays on screen only while the next is on its way (`listState`'s
 * `transition`) — and only for the SAME position: another position's rows are never this
 * one's, so a new `item_id` starts with nothing (E06).
 */
export function useStockJournalPage(params: StockJournalPageParams) {
  return useQuery<StockJournalPage>({
    queryKey: ['stock-journal-page', params],
    queryFn: () => api.getStockJournal(params),
    placeholderData: (previous, previousQuery) =>
      (previousQuery?.queryKey[1] as StockJournalPageParams | undefined)?.item_id === params.item_id ? previous : undefined,
    retry: false,
  });
}

/**
 * The journal's product filter: the products the chosen books moved (`GET
 * /stock/journal/products`, ST2). The previous book's list stays as a placeholder — a NAME
 * for a chosen product while the new list is read, never a verdict on it (R05).
 */
export function useStockJournalProducts(book: StockJournalBook) {
  return useQuery<StockJournalProduct[]>({
    queryKey: ['stock-journal-products', book],
    queryFn: () => api.getStockJournalProducts(book),
    placeholderData: keepPreviousData,
    retry: false,
  });
}
