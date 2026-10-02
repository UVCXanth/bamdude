import { useTranslation } from 'react-i18next';
import type { ProductListItem } from '../../../api/client';

type Fields = Pick<
  ProductListItem,
  'printed_parts_count' | 'purchased_parts_count' | 'plates_count' | 'variant_group_names' | 'active_orders_count'
>;

/**
 * What the product is made of (WS-13 E8 B03) — the mockup's «Склад виробу» cell:
 * printed parts, bought ones when there are any, plates; the variant groups; the
 * active orders it stands in. Every figure is the row's (E1 PC3) — `printed_parts_count`
 * leaves out a part marked «do not count». The card says the same on one line,
 * without the orders (the table carries them).
 */
export function ProductComposition({ product, variant }: { product: Fields; variant: 'table' | 'card' }) {
  const { t } = useTranslation();
  const plates = t('products.row.plates', { count: product.plates_count });
  const variants =
    product.variant_group_names.length > 0 ? t('products.row.variants', { names: product.variant_group_names.join(', ') }) : null;

  if (variant === 'card') {
    return (
      <small data-testid="product-composition" className="block text-xs text-bambu-gray">
        {[t('products.row.cardParts', { count: product.printed_parts_count }), plates, variants].filter(Boolean).join(' · ')}
      </small>
    );
  }
  return (
    <div data-testid="product-composition">
      <span className="text-white">
        {t('products.row.printedParts', { count: product.printed_parts_count })}
        {product.purchased_parts_count > 0 && t('products.row.purchased', { count: product.purchased_parts_count })}
        {' · '}
        {plates}
      </span>
      {variants && <small className="block text-xs text-bambu-gray">{variants}</small>}
      {product.active_orders_count > 0 && (
        <small className="block text-xs text-bambu-gray">{t('products.row.activeOrders', { count: product.active_orders_count })}</small>
      )}
    </div>
  );
}
