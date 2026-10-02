import { useTranslation } from 'react-i18next';
import type { ProductListItem } from '../../../api/client';

/**
 * What is on the shelf (WS-13 E8 B06) — the mockup's `stockCell`: finished units
 * (green when there are any), across how many configurations when more than one,
 * a warning when a position is below its minimum; under it, the kits the free
 * parts make. Every figure is the server's (E1 PC3) — a zero is its zero.
 */
export function ProductStock({
  product,
}: {
  product: Pick<ProductListItem, 'finished_available' | 'finished_positions' | 'finished_below_min' | 'kits_available'>;
}) {
  const { t } = useTranslation();
  const available = product.finished_available;
  return (
    <div data-testid="product-stock" className="text-sm">
      <b className={`tabular-nums ${available > 0 ? 'text-bambu-green' : 'text-bambu-gray'}`}>{available}</b>{' '}
      <small className="text-xs text-bambu-gray">
        {t('products.row.finished', { count: available })}
        {product.finished_positions > 1 && t('products.row.inConfigs', { count: product.finished_positions })}
        {product.finished_below_min > 0 && (
          <>
            {' · '}
            <span className="text-amber-700 dark:text-amber-400">{t('products.row.belowMin')}</span>
          </>
        )}
      </small>
      <small className="block text-xs text-bambu-gray">{t('products.row.kits', { count: product.kits_available })}</small>
    </div>
  );
}
