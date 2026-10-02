import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { ProductListItem } from '../../api/client';
import { SortableHeader } from '../SortableHeader';
import { WorkshopPanel, WorkshopTableScroll } from '../workshop/WorkshopPanel';
import { ProductActionMenu } from './ProductActionMenu';
import type { ProductActionsHost } from './productActions/useProductActions';
import { ProductBadges } from './productRow/ProductBadges';
import { ProductComposition } from './productRow/ProductComposition';
import { ProductIdentity } from './productRow/ProductIdentity';
import { ProductMaterials } from './productRow/ProductMaterials';
import { ProductModels } from './productRow/ProductModels';
import { ProductStock } from './productRow/ProductStock';
import { ProductThumb } from './productRow/ProductThumb';

/** The keys the table's own headers sort by — every other key is named by the page's chip (D03). */
export const TABLE_SORT_KEYS = ['name', 'printed_parts', 'finished'] as const;

/**
 * The catalog as a table — the mockup's six columns (WS-13 E8 D01): product / SKU,
 * composition, printers, material / colour, stock and the menu. Every cell is a part of
 * `productRow/` and draws the row's own fields; nothing is counted here.
 *
 * Sorting is the SERVER's (`sort_by`): the rows are one page of many. Three headers
 * sort, as in the mockup — the name A→Z first, the printed parts and the finished stock
 * largest first (D02); printers and materials have no server key (PC5). `footer` (the
 * page bar) sits inside the same panel, outside the rows' horizontal scroll, which is the
 * table's own region at 760 and narrower (D04).
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
  const plain = (label: string) => <th className="font-normal text-left">{label}</th>;

  return (
    <WorkshopPanel flush footer={footer}>
      <WorkshopTableScroll label={t('products.table.label')}>
        <table className="w-full text-sm">
          <thead className="text-xs text-bambu-gray bg-bambu-dark-secondary [&_th]:px-3 [&_th]:py-2">
            <tr>
              <SortableHeader
                sortKey="name"
                label={t('products.table.product')}
                sort={sort}
                onSort={onSortChange}
                className="w-[36%]"
              />
              <SortableHeader
                sortKey="printed_parts"
                label={t('products.table.composition')}
                sort={sort}
                onSort={onSortChange}
                descFirst
              />
              {plain(t('products.table.printers'))}
              {plain(t('products.table.materialColour'))}
              <SortableHeader sortKey="finished" label={t('products.table.stock')} sort={sort} onSort={onSortChange} descFirst />
              <th className="w-[1%]" aria-label={t('common.actions')}>
                <span className="sr-only">{t('common.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {products.map((p) => (
              <tr
                key={p.id}
                data-testid={`product-row-${p.id}`}
                className="border-t border-bambu-dark-tertiary text-white align-top hover:bg-bambu-dark-tertiary/30 [&>td]:px-3 [&>td]:py-2.5"
              >
                <td>
                  <div className="flex items-start gap-2.5">
                    <ProductThumb product={p} variant="table" />
                    <div className="min-w-0">
                      <Link to={`/products/${p.id}`} className="font-medium break-words hover:underline">
                        {p.name}
                      </Link>{' '}
                      <ProductBadges product={p} />
                      <ProductIdentity product={p} variant="table" />
                    </div>
                  </div>
                </td>
                <td>
                  <ProductComposition product={p} variant="table" />
                </td>
                <td>
                  <ProductModels product={p} />
                </td>
                <td>
                  <ProductMaterials product={p} variant="table" />
                </td>
                <td>
                  <ProductStock product={p} />
                </td>
                <td className="w-[1%]">
                  <ProductActionMenu product={p} testId={`product-${p.id}-row-menu`} actions={actions} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </WorkshopTableScroll>
    </WorkshopPanel>
  );
}
