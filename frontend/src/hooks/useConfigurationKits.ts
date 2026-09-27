import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { KitsConfiguration } from '../api/client';

/**
 * Whole kits of ONE configuration the shelf can make — what a line with those
 * options and counts may take off it (spec workshop-product-variants). The
 * product's own `kits_available` (`useProductStock`) is the STANDARD kit's; a
 * line that chose other options reserves its own kit, so offering the standard
 * number there promised kits the server would then clamp away.
 *
 * `config` is `null` for "the standard kit" — the caller reads
 * `useProductStock` then, and this query stays disabled. The key carries the
 * configuration in a stable order, so the same choice is one cache entry.
 */
export function useConfigurationKits(productId: number | null, config: KitsConfiguration | null) {
  const options = [...(config?.options ?? [])].sort((a, b) => a - b);
  const counts = Object.entries(config?.counts ?? {})
    .map(([pid, qty]) => `${pid}:${qty}`)
    .sort();
  return useQuery<{ kits_available: number }>({
    queryKey: ['product-kits', productId, options.join(','), counts.join(',')],
    queryFn: () => api.getConfigurationKits(productId as number, { options, counts: config?.counts ?? {} }),
    enabled: Number.isFinite(productId) && config != null,
    retry: false,
  });
}
