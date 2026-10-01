import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

/**
 * The queries of issuing an order (spec workshop-order-issue) — each key declared
 * here once, so no second observer takes its options over (`detailQueryKeys.test`).
 */

/** The fulfilment state's query — its one declaration, shared by the hook below and by the
 *  issue dialog's explicit re-read after a refusal (WS-13 E6 R04), so the two never carry
 *  different options for one entry. */
export function fulfilmentQuery(orderId: number | null) {
  return {
    queryKey: ['project-fulfilment', orderId] as const,
    queryFn: () => api.getFulfilment(orderId as number),
  };
}

/** What the order could assemble, receive and issue now — the issue dialog, the order
 *  page's header and banner, and the order form all read this one. */
export function useFulfilment(orderId: number | null, enabled = true) {
  return useQuery({
    ...fulfilmentQuery(orderId),
    enabled: orderId != null && enabled,
  });
}

/** «Take from stock»: what the shelves could give for what nobody printed or queued. */
export function useStockOffers(orderId: number, enabled = true) {
  return useQuery({
    queryKey: ['project-stock-offers', orderId],
    queryFn: () => api.getStockOffers(orderId),
    enabled,
  });
}
