import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { StockSuggestItem, StockSuggestion } from '../api/client';

/** How long a change of quantity or configuration waits before it is asked (spec rule 20). */
export const SUGGEST_DEBOUNCE_MS = 300;

/**
 * Where a picked row's proposal stands (WS-13 E5 C06, R02):
 * - `current` — the answer is for exactly what the row asks now;
 * - `waiting` — what the row asks now is still waiting out the debounce or in flight;
 * - `failed` — what the row asks now was refused, and there is no answer for it.
 */
export type SuggestStatus = 'current' | 'waiting' | 'failed';

/** One item's identity: its product, its options as a set, its quantity. */
function itemKey(item: StockSuggestItem): string {
  return JSON.stringify([item.product_id, [...(item.options ?? [])].sort((a, b) => a - b), item.quantity]);
}

/**
 * The server's stock proposal for every picked line — ONE `/stock/suggest`
 * request for the whole selection, 300 ms after the last change (spec
 * workshop-add-to-order, rule 20). The proposal is computed on the server;
 * this hook only asks and keys the answer by product.
 *
 * ⚠️ **An answer knows the question it answers** (WS-13 E5 R02). Until the new
 * question is answered the query keeps the previous numbers on screen, and those
 * may be another configuration's or another quantity's. So each answer carries
 * its request, and `current` holds a product's proposal ONLY when it answers
 * exactly what that row asks now; `status` says for every other row whether it
 * is still being asked or was refused. `refreshFailed` marks a row whose answer
 * stands while re-reading that same question failed — the numbers may be old.
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
    queryFn: async () => {
      const request = JSON.parse(asked) as StockSuggestItem[];
      const answer = await api.suggestStock(request);
      return { request, items: answer.items };
    },
    enabled: enabled && asked !== '[]',
    // The previous numbers stay in the cache while the next ones load — but a row
    // shows them only when they answer its own question (`current`).
    placeholderData: keepPreviousData,
  });

  const { current, status, refreshFailed } = useMemo(() => {
    const current = new Map<number, StockSuggestion>();
    const status = new Map<number, SuggestStatus>();
    const refreshFailed = new Set<number>();
    const answered = new Map<number, string>();
    for (const item of query.data?.request ?? []) answered.set(item.product_id, itemKey(item));
    const byProduct = new Map((query.data?.items ?? []).map((s) => [s.product_id, s]));
    const inFlight = asked !== key || query.isFetching;
    for (const item of items) {
      const suggestion = byProduct.get(item.product_id);
      if (suggestion && answered.get(item.product_id) === itemKey(item)) {
        current.set(item.product_id, suggestion);
        status.set(item.product_id, 'current');
        // An answer to this very question stands, but re-reading it failed.
        if (query.isError && !inFlight) refreshFailed.add(item.product_id);
      } else if (!inFlight && !query.isError && answered.get(item.product_id) === itemKey(item)) {
        // Answered for exactly this question, yet without this row: nothing more is coming.
        status.set(item.product_id, 'failed');
      } else {
        status.set(item.product_id, inFlight || !query.isError ? 'waiting' : 'failed');
      }
    }
    return { current, status, refreshFailed };
  }, [items, query.data, query.isError, query.isFetching, asked, key]);

  return {
    current,
    status,
    refreshFailed,
    retry: () => void query.refetch(),
  };
}
