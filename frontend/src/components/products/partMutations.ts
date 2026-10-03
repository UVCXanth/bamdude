import type { QueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { ProductPart } from '../../api/client';
import { invalidateOrderViews, invalidateProductFiles } from '../../utils/queryInvalidation';

/**
 * Every write of a product's composition — the part dialog, a merge, a delete — carries this
 * key, so a door can wait for all of them (`useIsMutating`).
 */
export function compositionMutationKey(productId: number) {
  return ['product-composition', productId] as const;
}

/** The same for the variant groups and options — the manager's one `PUT` carries it. */
export function variantsMutationKey(productId: number) {
  return ['product-variants', productId] as const;
}

/**
 * What a change of the composition makes stale: the product, and what it prints from
 * (`invalidateProductFiles`: plates, sources, the files tab, the estimate) — a part's
 * name, aliases or existence change what the plate walk matches, and a bought part's
 * price moves the estimate. And the order views: a part's count, binding or existence moves
 * the kits of saved order lines (a new part enters them at once, WS-13 E10 K22), so their
 * figures and stock reservations are stale too — one helper decides those keys.
 */
export function invalidateComposition(qc: QueryClient, productId: number): void {
  qc.invalidateQueries({ queryKey: ['product', productId] });
  invalidateProductFiles(qc, productId);
  invalidateOrderViews(qc);
}

/** One delete of a part for every door — the row menu's and the editor's (D05). */
export async function deleteProductPart(qc: QueryClient, productId: number, part: Pick<ProductPart, 'id'>): Promise<void> {
  await api.deleteProductPart(productId, part.id);
  invalidateComposition(qc, productId);
}
