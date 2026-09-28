import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

/**
 * The queries of issuing an order (spec workshop-order-issue) — each key declared
 * here once, so no second observer takes its options over (`detailQueryKeys.test`).
 */

/** What the order could assemble, receive and issue now — the issue dialog, the order
 *  page's header and banner, and the order form all read this one. */
export function useFulfilment(orderId: number | null, enabled = true) {
  return useQuery({
    queryKey: ['project-fulfilment', orderId],
    queryFn: () => api.getFulfilment(orderId as number),
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
