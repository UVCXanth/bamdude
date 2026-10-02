import { useTranslation } from 'react-i18next';
import type { ProductListItem } from '../../../api/client';

/**
 * The printer models the product is sliced for (WS-13 E8 B04) — the mockup's
 * «Принтери» chips. `sliced` is the server's (E1 PC2: a printable linked file
 * outside the trash): without one the product is «not sliced», in amber; sliced
 * but with no model named in its files is a dash, never an invented chip.
 */
export function ProductModels({ product }: { product: Pick<ProductListItem, 'models' | 'sliced'> }) {
  const { t } = useTranslation();
  return (
    <span data-testid="product-models" className="inline-flex flex-wrap items-center gap-1">
      {!product.sliced ? (
        <small className="text-xs text-amber-700 dark:text-amber-400">{t('products.row.unsliced')}</small>
      ) : product.models.length === 0 ? (
        <span className="text-bambu-gray">—</span>
      ) : (
        product.models.map((model) => (
          <span
            key={model}
            data-testid="product-model-chip"
            className="inline-block rounded px-1.5 text-[11px] leading-5 bg-blue-500/15 text-blue-700 dark:text-blue-300"
          >
            {model}
          </span>
        ))
      )}
    </span>
  );
}
