import { useTranslation } from 'react-i18next';
import type { Product } from '../../../api/client';
import { productPositionsParams, useStockItems } from '../../../hooks/useFinishedStock';
import { lineConfigLabel } from '../../projects/lineConfigLabel';
import { LoadFailedNote } from '../../workshop/LoadFailedNote';
import { RefreshFailedNote } from '../../workshop/RefreshFailedNote';

/**
 * The positions of a product in several configurations (WS-13 E9 B09): «{configuration}:
 * {available}» through « · ». The list is the «Stock» tab's (`productPositionsParams`) —
 * one request for both. Its own states: «…» while it reads, a sentence and a retry when
 * it failed with nothing to show, the rows under a refresh note when a re-read failed.
 */
function PositionsBreakdown({ productId }: { productId: number }) {
  const { t } = useTranslation();
  const positions = useStockItems(productPositionsParams(productId));
  let body;
  if (!positions.data) {
    body = positions.isError ? (
      <LoadFailedNote
        role="status"
        className="text-xs"
        message={t('products.detail.stock.breakdownFailed')}
        onRetry={() => positions.refetch()}
      />
    ) : (
      <small className="block text-xs text-bambu-gray">…</small>
    );
  } else {
    body = (
      <>
        {positions.isError && <RefreshFailedNote onRetry={() => positions.refetch()} />}
        <small className="block text-xs text-bambu-gray">
          {positions.data.items
            .map((item) => `${lineConfigLabel(item.configuration, undefined, t) || item.code}: ${item.available}`)
            .join(' · ')}
        </small>
      </>
    );
  }
  return (
    <div data-testid="product-stock-breakdown" className="mt-0.5">
      {body}
    </div>
  );
}

/**
 * «Stock» of the side panel (WS-13 E9 B09, R06): the product's own figures, always — free
 * ready units and the kits the free parts make (a zero is the server's zero), amber «below
 * minimum» when a position is under its minimum; the breakdown by position only when there
 * are several, and whatever state it is in, the figures above it stay.
 */
export function ProductStockFact({
  product,
}: {
  product: Pick<Product, 'id' | 'finished_available' | 'finished_positions' | 'finished_below_min' | 'kits_available'>;
}) {
  const { t } = useTranslation();
  return (
    <div data-testid="product-stock-fact">
      <b className="text-sm font-medium text-white">
        {product.finished_available} {t('products.row.finished', { count: product.finished_available })} ·{' '}
        {t('products.detail.stock.kits', { count: product.kits_available })}
      </b>
      {product.finished_below_min > 0 && (
        <small className="block mt-0.5 text-xs text-amber-700 dark:text-amber-400">{t('products.row.belowMin')}</small>
      )}
      {product.finished_positions > 1 && <PositionsBreakdown productId={product.id} />}
    </div>
  );
}
