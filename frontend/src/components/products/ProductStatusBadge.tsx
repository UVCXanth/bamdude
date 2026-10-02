import { useTranslation } from 'react-i18next';
import type { ProductListItem } from '../../api/client';

/**
 * A product's readiness (spec workshop-product-catalog, rules 14 and 22).
 *
 * «Incomplete» is a READY product that has since lost its parts or its plates:
 * the server never demotes it on its own — that would silently undo what the
 * operator set — so the list says so from the counts it already carries.
 * `showReady` is for the table's status column; a card shows nothing for the
 * ordinary case.
 */
export function ProductStatusBadge({
  product,
  showReady = false,
}: {
  product: Pick<ProductListItem, 'status' | 'parts_count' | 'plates_count'>;
  showReady?: boolean;
}) {
  const { t } = useTranslation();
  if (product.status === 'draft') {
    return (
      <span className="inline-block px-2 py-0.5 rounded-full text-xs bg-amber-500/15 text-amber-700 dark:text-amber-400">
        {t('products.status.draft')}
      </span>
    );
  }
  if (product.parts_count === 0 || product.plates_count === 0) {
    return (
      <span
        title={t('products.status.incompleteHint')}
        className="inline-block px-2 py-0.5 rounded-full text-xs bg-red-500/15 text-red-600 dark:text-red-400"
      >
        {t('products.status.incomplete')}
      </span>
    );
  }
  return showReady ? <span className="text-bambu-gray">{t('products.status.ready')}</span> : null;
}
