import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { PackageCheck } from 'lucide-react';
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
  const offerTexts = offers.map((o) => t('orders.take.offer', { product: o.product_name, ready: o.from_finished, kits: o.kits }));

  // WS-13 E3 D05: the mockup's one-line note — «In stock for this order: «A» — N
  // ready + K kits; «B» — …. Take it — and print less.» — with the one action on
  // the right, under the text where the row is too narrow.
  return (
    <div
      data-testid="take-stock"
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-xl border border-bambu-green/30 bg-bambu-green/10 px-4 py-3 text-sm leading-5 text-white"
    >
      <p className="min-w-0 flex-1">
        <PackageCheck className="mr-1.5 inline h-4 w-4 align-[-3px] text-bambu-green" aria-hidden />
        {t('orders.take.title')}:{' '}
        {offerTexts.map((text, index) => (
          <span key={offers[index].line_id}>
            {index > 0 && '; '}
            <span>{text}</span>
          </span>
        ))}
        {/* One full stop: the Ukrainian offer already ends in «компл.». */}
        {offerTexts[offerTexts.length - 1].endsWith('.') ? ' ' : '. '}
        {t('orders.take.body')}
      </p>
      <Button size="sm" onClick={() => take.mutate(offers)} disabled={take.isPending}>
        {t('orders.take.action')}
      </Button>
    </div>
  );
}
