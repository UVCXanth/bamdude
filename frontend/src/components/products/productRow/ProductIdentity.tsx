import { useTranslation } from 'react-i18next';
import type { ProductListItem } from '../../../api/client';

/**
 * Who the product is, in one mono line (WS-13 E8 B02): the system code first, then
 * the operator's SKU — both, never one standing in for the other (P11, WS-03) —
 * the version and, in the table, the category. The mockup's slot holds the SKU
 * alone (`—` without one, «no category»); the code is the app's. A long SKU breaks anywhere —
 * in a table only `anywhere` counts toward the column's minimum width.
 */
export function ProductIdentity({
  product,
  variant,
}: {
  product: Pick<ProductListItem, 'code' | 'sku' | 'version' | 'category'>;
  variant: 'table' | 'card';
}) {
  const { t } = useTranslation();
  const sku = product.sku || '—';
  const text =
    variant === 'card'
      ? [product.code, sku, product.version].filter(Boolean).join(' · ')
      : `${product.code} · ${sku}${product.version ? ` ${product.version}` : ''} · ${product.category?.name ?? t('products.row.noCategory')}`;
  return (
    <small data-testid="product-identity" className="block font-mono text-xs text-bambu-gray wrap-anywhere">
      {text}
    </small>
  );
}
