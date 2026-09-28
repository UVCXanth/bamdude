import { useTranslation } from 'react-i18next';
import { CheckCircle2 } from 'lucide-react';
import type { FulfilmentState, Order } from '../../api/client';
import type { FulfilmentMode } from './fulfilment/fulfilmentState';
import { Button } from '../Button';

interface CloseSuggestionBannerProps {
  order: Order;
  /** The order's issue state — the numbers the buttons carry; absent while it loads. */
  state?: FulfilmentState;
  /** Open the issue dialog: to receive only, or to issue everything — `complete` ticks «Close the order». */
  onFulfil: (mode: FulfilmentMode, complete: boolean) => void;
}

/**
 * "Everything is covered — receive, issue, close?"
 *
 * A SUGGESTION and never an action: nothing here closes the order on its own.
 * `all_printed` says the prints are in, not that the parcel went out. Every
 * button opens the issue dialog (spec workshop-order-issue, rules 26 and 28):
 * receiving the printed units, issuing what is on the shelf, or «mark
 * completed» — which, since an order closes only when everything is issued,
 * is the dialog prefilled with everything and ticked to close.
 *
 * `all_printed` is the server's own verdict (design decision 8), and the
 * counts are the server's totals (`can_receive`, `can_issue`) — this component
 * never adds lines up.
 */
export function CloseSuggestionBanner({ order, state, onFulfil }: CloseSuggestionBannerProps) {
  const { t } = useTranslation();

  // A closed order has nothing to suggest: `completed` is already there, and
  // `cancelled` is a decision this banner must not quietly undo.
  if (!order.figures.all_printed || order.status !== 'active') return null;

  return (
    <div
      data-testid="close-suggestion"
      className="flex items-start justify-between gap-4 flex-wrap rounded-xl border border-bambu-green/40 bg-bambu-green/10 p-4"
    >
      <div className="flex items-start gap-3 min-w-0">
        <CheckCircle2 className="w-5 h-5 text-bambu-green flex-shrink-0 mt-0.5" />
        <div className="min-w-0">
          <p className="text-white font-medium">{t('orders.close.title')}</p>
          <p className="text-sm text-bambu-gray">{t('orders.close.body')}</p>
          {state && (
            <p className="text-sm text-bambu-gray tabular-nums" data-testid="close-suggestion-issued">
              {t('orders.close.issuedLine', { issued: state.issued, ordered: state.ordered, held: state.held })}
            </p>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        {state && state.can_receive > 0 && (
          <Button variant="secondary" data-testid="close-suggestion-receive" onClick={() => onFulfil('receive', false)}>
            {t('orders.close.receive', { count: state.can_receive })}
          </Button>
        )}
        {/* No customer: nothing is issued — the order closes to stock (followups, rule 39). */}
        {state && !state.closes_to_stock && state.can_issue > 0 && (
          <Button variant="secondary" data-testid="close-suggestion-issue" onClick={() => onFulfil('all', false)}>
            {t('orders.close.issue', { count: state.can_issue })}
          </Button>
        )}
        <Button data-testid="close-suggestion-complete" onClick={() => onFulfil('all', true)}>
          {t(state?.closes_to_stock ? 'orders.close.toStock' : 'orders.close.action')}
        </Button>
      </div>
    </div>
  );
}
