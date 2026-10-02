import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { ProductFileGroups } from '../api/client';

/**
 * A product's linked files with their plates and its linked folders (`GET /products/{id}/files`,
 * PS7 + WS-13 E9 A03) — the «Plates and files» tab and the re-read dialog ask the same
 * question, declared once so the two never disagree on its options.
 */
export function useProductFileGroups(productId: number) {
  return useQuery<ProductFileGroups>({
    queryKey: ['product-file-groups', productId],
    queryFn: () => api.getProductFileGroups(productId),
    retry: false,
  });
}
