import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Package } from 'lucide-react';
import { api } from '../../api/client';
import type { ProductListItem } from '../../api/client';
import { SortableHeader } from '../SortableHeader';
import { ProductActionMenu } from './ProductActionMenu';
import type { ProductActionsHost } from './productActions/useProductActions';
import { ProductStatusBadge } from './ProductStatusBadge';

/**
 * The catalog as a table — the second view of the products page.
 *
 * Sorting is the SERVER's (`sort_by`): the rows are one page of many, and a
 * header that sorted only what is on screen would read as the whole catalog's
 * order while being one page's. The menu is the card's own `ProductActionMenu`.
 * `footer` (the page bar) is drawn inside the same card, under the rows.
 */
export function ProductsTable({
  products,
  sort,
  onSortChange,
  footer,
  actions,
}: {
  products: ProductListItem[];
  /** The page's action host (WS-13 E8 F01). */
  actions: ProductActionsHost<ProductListItem>;
  /** The current `sort_by`, e.g. `name-asc`. */
  sort: string;
  onSortChange: (sortBy: string) => void;
  footer?: ReactNode;
}) {
  const { t } = useTranslation();

  return (
    <div className="rounded-xl border border-bambu-dark-tertiary overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-bambu-gray bg-bambu-dark-secondary">
            <tr>
              {/* Numbers read best largest-first; a name reads best A→Z. */}
              <SortableHeader sortKey="name" label={t('products.table.name')} sort={sort} onSort={onSortChange} />
              <SortableHeader sortKey="sku" label={t('products.table.sku')} sort={sort} onSort={onSortChange} />
              <th className="font-normal p-2 text-left">{t('products.table.version')}</th>
              <SortableHeader sortKey="category" label={t('products.table.category')} sort={sort} onSort={onSortChange} />
              <SortableHeader sortKey="status" label={t('products.table.status')} sort={sort} onSort={onSortChange} />
              <SortableHeader sortKey="parts" label={t('products.table.parts')} sort={sort} onSort={onSortChange} descFirst align="right" />
              <SortableHeader sortKey="plates" label={t('products.table.plates')} sort={sort} onSort={onSortChange} descFirst align="right" />
              <SortableHeader sortKey="orders" label={t('products.table.orders')} sort={sort} onSort={onSortChange} descFirst align="right" />
              <SortableHeader sortKey="kits" label={t('products.table.kits')} sort={sort} onSort={onSortChange} descFirst align="right" />
              <th className="font-normal p-2 text-left">{t('products.table.catalog')}</th>
              <th className="p-2" aria-label={t('common.actions')} />
            </tr>
          </thead>
          <tbody>
            {products.map((p) => (
              <tr key={p.id} className="border-t border-bambu-dark-tertiary text-white">
                <td className="p-2">
                  <Link to={`/products/${p.id}`} className="flex items-center gap-2 hover:underline">
                    {p.has_cover ? (
                      <img
                        data-testid="product-cover"
                        src={api.getProductCoverImageUrl(p.id)}
                        alt=""
                        className="w-9 h-9 flex-shrink-0 rounded object-contain bg-bambu-dark"
                      />
                    ) : (
                      <span className="w-9 h-9 flex-shrink-0 rounded bg-bambu-dark flex items-center justify-center">
                        <Package className="w-4 h-4 text-bambu-gray" />
                      </span>
                    )}
                    <span className="min-w-0">
                      <span className="block truncate">{p.name}</span>
                      <span className="block text-xs text-bambu-gray">{p.code}</span>
                    </span>
                  </Link>
                </td>
                <td className="p-2 whitespace-nowrap">{p.sku ?? ''}</td>
                <td className="p-2 text-bambu-gray">{p.version ?? ''}</td>
                <td className="p-2">{p.category?.name ?? ''}</td>
                <td className="p-2 whitespace-nowrap">
                  <ProductStatusBadge product={p} showReady />
                </td>
                <td className="p-2 text-right tabular-nums">{p.parts_count}</td>
                <td className="p-2 text-right tabular-nums">{p.plates_count}</td>
                <td className="p-2 text-right tabular-nums">{p.lines_count}</td>
                <td className="p-2 text-right tabular-nums">{p.kits_available}</td>
                <td className="p-2 text-bambu-gray">{p.is_active ? t('common.yes') : t('products.card.inactive')}</td>
                <td className="p-2 text-right">
                  <ProductActionMenu product={p} testId={`product-${p.id}-row-menu`} actions={actions} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {footer}
    </div>
  );
}
