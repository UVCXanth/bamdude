import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

/** The delivery reference; its writes invalidate this key and `['customers']` (contacts show the names). */
export function useDeliveryMethods() {
  return useQuery({ queryKey: ['delivery-methods'], queryFn: () => api.getDeliveryMethods() });
}
