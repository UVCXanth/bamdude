import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Warehouse } from 'lucide-react';
import { api } from '../../api/client';
import type { StockOffer, TakeStockResult } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { useStockOffers } from '../../hooks/useFulfilment';
import { invalidateOrderViews } from '../../utils/queryInvalidation';
import { Button } from '../Button';

/**
 * «На складі є для цього замовлення — узяти і друкувати менше» (spec
 * workshop-order-issue, rules 17 and 26): what the shelves hold for the part of
 * the order nobody printed, is printing or has queued, and one button that takes
 * it. The offer is the server's (`GET …/stock-offers`); the take sends what the
 * banner SHOWED, so the answer can say where the shelf gave less.
 */
export function TakeStockBanner({ orderId }: { orderId: number }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { showToast } = useToast();
  const { data: offers = [] } = useStockOffers(orderId);

  const take = useMutation({
    mutationFn: (shown: StockOffer[]) =>
      api.takeStock(orderId, {
        lines: shown.map((o) => ({ line_id: o.line_id, from_finished: o.from_finished, kits: o.kits })),
      }),
    onSuccess: (result: TakeStockResult, shown) => {
      invalidateOrderViews(qc, { orderId });
      const names = new Map(shown.map((o) => [o.line_id, o.product_name]));
      const short = result.results
        .filter((r) => r.got_finished < r.asked_finished || r.got_kits < r.asked_kits)
        .map((r) => {
          const what = [
            r.got_finished < r.asked_finished &&
              t('orders.add.clampedReady', { got: r.got_finished, asked: r.asked_finished }),
            r.got_kits < r.asked_kits && t('orders.add.clampedKits', { got: r.got_kits, asked: r.asked_kits }),
          ]
            .filter(Boolean)
            .join(', ');
          return t('orders.add.clampedLine', { name: names.get(r.line_id) ?? '', what });
        });
      if (short.length > 0) showToast(t('orders.take.clamped', { detail: short.join('; ') }), 'warning');
      else showToast(t('orders.take.taken'));
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  if (offers.length === 0) return null;

  return (
    <div
      data-testid="take-stock"
      className="flex items-start justify-between gap-4 flex-wrap rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary p-4"
    >
      <div className="flex items-start gap-3 min-w-0">
        <Warehouse className="w-5 h-5 text-bambu-green flex-shrink-0 mt-0.5" />
        <div className="min-w-0">
          <p className="text-white font-medium">{t('orders.take.title')}</p>
          <ul className="text-sm text-bambu-gray">
            {offers.map((o) => (
              <li key={o.line_id}>
                {t('orders.take.offer', { product: o.product_name, ready: o.from_finished, kits: o.kits })}
              </li>
            ))}
          </ul>
          <p className="text-xs text-bambu-gray mt-1">{t('orders.take.body')}</p>
        </div>
      </div>
      <Button onClick={() => take.mutate(offers)} disabled={take.isPending}>
        {t('orders.take.action')}
      </Button>
    </div>
  );
}
