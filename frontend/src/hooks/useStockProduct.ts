import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

/**
 * The product a stock dialog acts on, as the stock catalog names it (WS-13 E13 STK-10): its
 * options and its origin, readable with the stock's read alone. `data` is null when the product
 * is gone. Shared by the dialogs' product choice and their target (one key, one read).
 */
export function useStockProduct(productId: number | null) {
  return useQuery({
    queryKey: ['stock-product', productId],
    queryFn: () => api.getStockProduct(productId as number),
    enabled: productId != null,
  });
}
