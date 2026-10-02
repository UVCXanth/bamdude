import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../../api/client';
import type { ProductEstimate } from '../../../api/client';
import { formatDuration } from '../../../utils/date';
import { formatWeight } from '../../../utils/weight';
import { LoadFailedNote } from '../../workshop/LoadFailedNote';
import { RefreshFailedNote } from '../../workshop/RefreshFailedNote';
import { estimateDisplay, type EstimateFigure } from './estimateDisplay';

/**
 * «Estimate per unit (standard configuration)» of the side panel (WS-13 E9 B08): the time
 * and the filament of one standard unit, from `GET /products/{id}/estimate` — never the
 * cost (K11). How each figure reads is `estimateDisplay`'s; the reasons under it are the
 * server's codes, in its order, named here.
 *
 * States: «…» on the first read; a failure with nothing to show is «—» and a retry; a
 * failed re-read keeps the figures under a refresh note.
 */
export function ProductEstimateFact({ productId }: { productId: number }) {
  const { t } = useTranslation();
  const estimate = useQuery<ProductEstimate>({
    queryKey: ['product-estimate', productId],
    queryFn: () => api.getProductEstimate(productId),
    retry: false,
  });

  if (!estimate.data) {
    return (
      <div data-testid="product-estimate">
        {estimate.isError ? (
          <>
            <b className="text-sm font-medium text-white">—</b>
            <LoadFailedNote
              role="status"
              className="text-xs"
              message={t('products.detail.estimate.loadFailed')}
              onRetry={() => estimate.refetch()}
            />
          </>
        ) : (
          <b className="text-sm font-medium text-bambu-gray">…</b>
        )}
      </div>
    );
  }

  const shown = estimateDisplay(estimate.data);
  const figure = (f: EstimateFigure, format: (v: number) => string) =>
    f.kind === 'unknown' ? '—' : f.kind === 'atLeast' ? t('products.detail.estimate.atLeast', { value: format(f.value) }) : format(f.value);
  const value =
    shown.kind === 'empty'
      ? '—'
      : shown.kind === 'noPrint'
        ? t('products.detail.estimate.noPrint')
        : `${figure(shown.time, formatDuration)} · ${figure(shown.grams, formatWeight)}`;

  return (
    <div data-testid="product-estimate">
      {estimate.isError && <RefreshFailedNote onRetry={() => estimate.refetch()} />}
      <b className="text-sm font-medium text-white">{value}</b>
      {shown.reasons.map((reason) => (
        <small key={reason.code} className="block mt-0.5 text-xs text-amber-700 dark:text-amber-400">
          {t(`projects.estimateReasons.${reason.code}`, { defaultValue: reason.code })}
          {reason.count != null && `: ${reason.count}`}
        </small>
      ))}
    </div>
  );
}
