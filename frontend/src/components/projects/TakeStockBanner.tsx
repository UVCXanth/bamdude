import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Trans, useTranslation } from 'react-i18next';
import { PackageCheck } from 'lucide-react';
import { api } from '../../api/client';
import type { ProjectLine, StockOffer, TakeStockResult } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { useStockOffers } from '../../hooks/useFulfilment';
import { invalidateOrderViews } from '../../utils/queryInvalidation';
import { Button } from '../Button';
import { lineConfigLabel } from './lineConfigLabel';

/**
 * «На складі є для цього замовлення — узяти і друкувати менше» (spec
 * workshop-order-issue, rules 17 and 26): what the shelves hold for the part of
 * the order nobody printed, is printing or has queued, and one button that takes
 * it. The offer is the server's (`GET …/stock-offers`); the take sends what the
 * banner SHOWED, so the answer can say where the shelf gave less.
 *
 * Each offer names its line's configuration (spec D05, E3-V04): two lines of one
 * product differ only by it. The caption is the lines table's own
 * (`lineConfigLabel`), found by `line_id` in the order the page has already read —
 * no request of its own; a line without variants gets none.
 */
export function TakeStockBanner({ orderId, lines = [] }: { orderId: number; lines?: ProjectLine[] }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { showToast } = useToast();
  const { data: offers = [] } = useStockOffers(orderId);
  const configOf = (lineId: number) => {
    const line = lines.find((l) => l.id === lineId);
    return line ? lineConfigLabel(line.configuration, line.mode, t) : '';
  };
  const lineName = (offer: StockOffer) => {
    const config = configOf(offer.line_id);
    return config ? t('orders.take.lineConfigured', { product: offer.product_name, config }) : offer.product_name;
  };

  const take = useMutation({
    mutationFn: (shown: StockOffer[]) =>
      api.takeStock(orderId, {
        lines: shown.map((o) => ({ line_id: o.line_id, from_finished: o.from_finished, kits: o.kits })),
      }),
    onSuccess: (result: TakeStockResult, shown) => {
      invalidateOrderViews(qc, { orderId });
      const names = new Map(shown.map((o) => [o.line_id, lineName(o)]));
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
  // Each offer is one translated sentence; a configuration is marked out inside it
  // in amber, as the mockup's `.m-cfg` (E3-V07) — through `Trans`, never a phrase
  // glued from pieces. `text` is the plain sentence, for the full-stop check below:
  // it ends the same with or without the configuration.
  const offerParts = offers.map((o) => {
    const config = configOf(o.line_id);
    const counts = { product: o.product_name, ready: o.from_finished, kits: o.kits };
    const text = t('orders.take.offer', counts);
    return {
      key: o.line_id,
      text,
      node: config ? (
        // `Trans` escapes the values before it parses the tags, so an option named «Ø < 5 mm»
        // cannot become markup; `shouldUnescape` turns the entities back into the text typed.
        <Trans
          i18nKey="orders.take.offerConfigured"
          values={{ ...counts, config }}
          shouldUnescape
          components={{ config: <span className="text-amber-700 dark:text-amber-400" /> }}
        />
      ) : (
        text
      ),
    };
  });

  // WS-13 E3 D05: the mockup's one-line note — «In stock for this order: «A» — N
  // ready + K kits; «B» — …. Take it — and print less.» — with the one action on
  // the right, under the text where the row is too narrow.
  return (
    <div
      data-testid="take-stock"
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-xl border border-bambu-green/30 bg-bambu-green/10 px-4 py-3 text-sm leading-5 text-white"
    >
      {/* A real basis, not `flex-1` (E3-V07, as the header's V01): with a zero basis the
          row never wraps and the button squeezes the sentence beside it at 390. With 20rem
          the button moves under the sentence as soon as the two do not fit (D03/D05). */}
      <p className="min-w-0 grow basis-80">
        <PackageCheck className="mr-1.5 inline h-4 w-4 align-[-3px] text-bambu-green" aria-hidden />
        {t('orders.take.title')}{' '}
        {offerParts.map((part, index) => (
          <span key={part.key}>
            {index > 0 && '; '}
            <span>{part.node}</span>
          </span>
        ))}
        {/* One full stop: the Ukrainian offer already ends in «компл.». */}
        {offerParts[offerParts.length - 1].text.endsWith('.') ? ' ' : '. '}
        {t('orders.take.body')}
      </p>
      <Button size="sm" onClick={() => take.mutate(offers)} disabled={take.isPending}>
        {t('orders.take.action')}
      </Button>
    </div>
  );
}
