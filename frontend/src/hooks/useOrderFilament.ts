import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

/**
 * The filament an order still needs against the shelf, `['order-filament', id]`
 * — one declaration for the order page's side panel and the plan dialog's
 * compact block (WS-13 E3 G03). Only an active order has a need to compute.
 */
export function useOrderFilament(orderId: number, enabled: boolean) {
  return useQuery({
    queryKey: ['order-filament', orderId],
    queryFn: () => api.getOrderFilament(orderId),
    enabled,
    staleTime: 30_000,
  });
}
