import { useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import type { Product } from '../../../api/client';
import { useAuth } from '../../../contexts/AuthContext';
import { productPositionsParams, useStockItems } from '../../../hooks/useFinishedStock';
import { listState } from '../../../utils/listState';
import { Button } from '../../Button';
import { lineConfigLabel } from '../../projects/lineConfigLabel';
import { StockMoveDialog } from '../../stock/StockMoveDialog';
import { LoadFailedNote } from '../../workshop/LoadFailedNote';
import { RefreshFailedNote } from '../../workshop/RefreshFailedNote';
import { ProductStock } from '../ProductStock';
import { ProductJournal } from './ProductJournal';

const HEAD = 'font-normal p-2 text-left';

/**
 * «Finished units — by configuration» (WS-13 E9 F01): the product's positions from the
 * side panel's own question (`productPositionsParams`), each a link to its position page
 * — where its reservations are listed (K4). «Receipt» opens the receipt for this product.
 * States of its own (`listState`).
 */
function FinishedPositions({ productId, canEdit }: { productId: number; canEdit: boolean }) {
  const { t } = useTranslation();
  const [receiving, setReceiving] = useState(false);
  const positions = useStockItems(productPositionsParams(productId));
  const state = listState({ data: positions.data, isError: positions.isError, isPlaceholderData: positions.isPlaceholderData });

  let body;
  if (state === 'loading') {
    body = <p className="text-sm text-bambu-gray">{t('common.loading')}</p>;
  } else if (state === 'failed') {
    body = (
      <LoadFailedNote role="status" message={t('products.detail.stockTab.positionsFailed')} onRetry={() => positions.refetch()} />
    );
  } else {
    const items = positions.data?.items ?? [];
    body = (
      <>
        {state === 'refresh-failed' && <RefreshFailedNote onRetry={() => positions.refetch()} />}
        {items.length === 0 ? (
          <p className="text-sm text-bambu-gray">{t('products.detail.stockTab.positionsEmpty')}</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-bambu-dark-tertiary">
            <table data-testid="stock-positions" className="w-full text-sm">
              <thead>
                <tr className="text-xs text-bambu-gray">
                  <th className={HEAD}>{t('products.detail.stockTab.configuration')}</th>
                  <th className={HEAD}>{t('products.detail.stockTab.location')}</th>
                  <th className={HEAD}>{t('products.detail.stockTab.onHand')}</th>
                  <th className={HEAD}>{t('products.detail.stockTab.reserved')}</th>
                  <th className={HEAD}>{t('products.detail.stockTab.available')}</th>
                  <th className={HEAD}>{t('products.detail.stockTab.min')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} data-testid={`stock-position-${item.id}`} className="border-t border-bambu-dark-tertiary text-white">
                    <td className="p-2">
                      <Link to={`/stock/${item.id}`} className="text-bambu-green hover:underline wrap-anywhere">
                        {lineConfigLabel(item.configuration, 'product', t) || item.code}
                      </Link>
                    </td>
                    <td className="p-2 text-bambu-gray-light">{item.location || '—'}</td>
                    <td className="p-2 tabular-nums">{item.on_hand}</td>
                    <td className="p-2 tabular-nums">{item.reserved}</td>
                    <td
                      data-testid="stock-position-available"
                      className={`p-2 tabular-nums ${item.below_min ? 'text-amber-700 dark:text-amber-400' : 'text-bambu-green'}`}
                    >
                      {item.available}
                    </td>
                    <td className="p-2 tabular-nums">{item.min_qty}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </>
    );
  }

  return (
    <section className="space-y-3 rounded-xl border border-bambu-dark-tertiary px-4 py-3.5" data-testid="stock-finished">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-base font-semibold text-white">{t('products.detail.stockTab.positions')}</h3>
        {canEdit && (
          <Button size="sm" variant="ghost" onClick={() => setReceiving(true)}>
            <Plus className="h-4 w-4" />
            {t('products.detail.stockTab.receipt')}
          </Button>
        )}
      </div>
      {body}
      {receiving && <StockMoveDialog kind="receipt" productId={productId} onClose={() => setReceiving(false)} />}
    </section>
  );
}

/**
 * The «Stock» tab of the product page (WS-13 E9 F01–F05): two cards in the mockup's grid
 * — the finished positions and the free parts, each with states of its own — and the
 * product's movements under them.
 */
export function ProductStockTab({ product }: { product: Pick<Product, 'id' | 'variant_groups'> }) {
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('projects:update');
  return (
    <div className="space-y-5">
      <div
        data-testid="stock-cards"
        className="grid items-start gap-3 grid-cols-[repeat(auto-fit,minmax(min(420px,100%),1fr))] max-[1101px]:grid-cols-1"
      >
        <FinishedPositions productId={product.id} canEdit={canEdit} />
        <ProductStock productId={product.id} canEdit={canEdit} hasVariants={(product.variant_groups ?? []).length > 0} />
      </div>
      <ProductJournal productId={product.id} />
    </div>
  );
}
