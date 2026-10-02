import { useTranslation } from 'react-i18next';
import type { ProductListItem } from '../../../api/client';
import { ProductStatusBadge } from '../ProductStatusBadge';

const NEUTRAL = 'inline-block px-2 py-0.5 rounded-full text-xs bg-bambu-dark text-bambu-gray';

/**
 * A catalog row's badges (WS-13 E8 B01) — the mockup's `productBadges`: readiness
 * («Draft», and «Incomplete» for a ready product that has lost its parts or plates —
 * the WS-07 rule the mockup does not draw), «not in catalog» for a catalogue product
 * hidden from it, «one-off» for a product made for an order. Hidden is the
 * catalogue's own state: a one-off is not «not in catalog», it never was in it.
 */
export function ProductBadges({
  product,
}: {
  product: Pick<ProductListItem, 'status' | 'parts_count' | 'plates_count' | 'is_active' | 'origin'>;
}) {
  const { t } = useTranslation();
  const catalog = product.origin === 'catalog';
  return (
    <span className="inline-flex flex-wrap items-center gap-1 align-middle">
      <ProductStatusBadge product={product} />
      {catalog && !product.is_active && <span className={NEUTRAL}>{t('products.row.hidden')}</span>}
      {!catalog && <span className={NEUTRAL}>{t('products.row.adhoc')}</span>}
    </span>
  );
}
