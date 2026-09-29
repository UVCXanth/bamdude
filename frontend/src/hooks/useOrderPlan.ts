import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

/**
 * An order's print plan, `['project-plan', id]` — one declaration for the plan
 * block that reads it and the tab strip that counts its rows (WS-13 E3 F01).
 *
 * The strip passes `enabled: false`: it only READS what the plan block fetched,
 * so a page opened on another tab asks for no plan just to put a number on a
 * tab (E1 CN2) — the count appears once the plan tab has been opened.
 */
export function useOrderPlan(orderId: number, enabled: boolean) {
  return useQuery({
    queryKey: ['project-plan', orderId],
    queryFn: () => api.getOrderPlan(orderId),
    enabled,
  });
}
