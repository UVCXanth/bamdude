import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { StockSuggestItem, StockSuggestion } from '../api/client';

/** How long a change of quantity or configuration waits before it is asked (spec rule 20). */
export const SUGGEST_DEBOUNCE_MS = 300;

/**
 * The server's stock proposal for every picked line — ONE `/stock/suggest`
 * request for the whole selection, 300 ms after the last change (spec
 * workshop-add-to-order, rule 20). The proposal is computed on the server;
 * this hook only asks and keys the answer by product.
 *
 * `enabled` is false for an order that takes nothing from stock (rule 7).
 */
export function useStockSuggest(items: StockSuggestItem[], enabled: boolean) {
  const key = JSON.stringify(items);
  const [asked, setAsked] = useState(key);
  useEffect(() => {
    const timer = setTimeout(() => setAsked(key), SUGGEST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [key]);

  const query = useQuery({
    queryKey: ['stock-suggest', asked],
    queryFn: () => api.suggestStock(JSON.parse(asked) as StockSuggestItem[]),
    enabled: enabled && asked !== '[]',
    // The previous numbers stay on screen while the next ones load.
    placeholderData: keepPreviousData,
  });

  const byProduct = useMemo(
    () => new Map<number, StockSuggestion>((query.data?.items ?? []).map((s) => [s.product_id, s])),
    [query.data],
  );
  // A failed proposal is said by the rows (final review M11), never left as «of —».
  return { byProduct, pending: enabled && (asked !== key || query.isFetching), failed: query.isError };
}
