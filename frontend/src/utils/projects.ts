import type { ProductOrigin } from '../api/client';

/**
 * Which products may be OFFERED when adding an order line or linking a file.
 *
 * A product leaves the catalog (`is_active === false`) as the explicit "stop
 * offering me this" action — the same meaning archiving carries for printers,
 * where a retired one disappears from every place that offers a choice rather
 * than being labelled in small print.
 *
 * ⚠️ **A product already bound stays on the list**, for the same reason a
 * bound order does: hiding it renders the field empty and the next save
 * commits that emptiness.
 *
 * ⚠️ **A missing flag counts as in the catalog.** Rows arrive from several
 * shapes (list item, detail, an embedded `ProductRef`), and an absent field is
 * "not told" rather than "retired" — defaulting the other way would empty a
 * picker whenever a lighter payload is what happens to be in hand.
 *
 * ⚠️ **An adhoc product is one the catalogue never saw** (spec 2026-09-06,
 * Decision 2) — created for one job or one plate rather than picked from the
 * catalogue. It is offered only where the row already links it, exactly like
 * an inactive one. No `origin` on the row (an older server) means catalogue.
 */
export function selectableProducts<T extends { id: number; is_active?: boolean; origin?: ProductOrigin }>(
  products: T[] | undefined | null,
  keepIds?: Iterable<number> | null,
): T[] {
  if (!products) return [];
  const keep = keepIds ? new Set(keepIds) : null;
  return products.filter(
    (p) => (p.is_active !== false && (p.origin == null || p.origin === 'catalog')) || keep?.has(p.id),
  );
}
