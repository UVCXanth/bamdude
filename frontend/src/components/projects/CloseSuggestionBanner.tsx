import { useTranslation } from 'react-i18next';
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
 *
 * WS-13 E3 D03/D04: the mockup's note — the text, then one row of actions under
 * it with ONE primary: receiving while there are prints to receive, else
 * issuing, else completing. An order without a customer is told what closing to
 * stock means (E04) instead of being offered an issue.
 */
export function CloseSuggestionBanner({ order, state, onFulfil }: CloseSuggestionBannerProps) {
  const { t } = useTranslation();

  // A closed order has nothing to suggest: `completed` is already there, and
  // `cancelled` is a decision this banner must not quietly undo.
  if (!order.figures.all_printed || order.status !== 'active') return null;

  const toStock = Boolean(state?.closes_to_stock);
  const canReceive = Boolean(state && state.can_receive > 0);
  // No customer: nothing is issued — the order closes to stock (followups, rule 39).
  const canIssue = Boolean(state && !toStock && state.can_issue > 0);
  // No lead until the issue state has come — the emphasis would jump when it does.
  const lead = !state ? null : canReceive ? 'receive' : canIssue ? 'issue' : 'complete';
  const emphasis = (which: 'receive' | 'issue' | 'complete') => (lead === which ? 'primary' : 'secondary');

  return (
    <div
      data-testid="close-suggestion"
      className="rounded-xl border border-bambu-green/30 bg-bambu-green/10 px-4 py-3 text-sm leading-5 text-white"
    >
      <p>
        <b className="font-semibold">{t('orders.close.title')}</b> {t(toStock ? 'orders.close.toStockBody' : 'orders.close.body')}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {canReceive && state && (
          <Button
            size="sm"
            variant={emphasis('receive')}
            data-emphasis={emphasis('receive')}
            data-testid="close-suggestion-receive"
            onClick={() => onFulfil('receive', false)}
          >
            {t('orders.close.receive', { count: state.can_receive })}
          </Button>
        )}
        {canIssue && state && (
          <Button
            size="sm"
            variant={emphasis('issue')}
            data-emphasis={emphasis('issue')}
            data-testid="close-suggestion-issue"
            onClick={() => onFulfil('all', false)}
          >
            {t('orders.close.issue', { count: state.can_issue })}
          </Button>
        )}
        <Button
          size="sm"
          variant={emphasis('complete')}
          data-emphasis={emphasis('complete')}
          data-testid="close-suggestion-complete"
          onClick={() => onFulfil('all', true)}
        >
          {t(toStock ? 'orders.close.toStock' : 'orders.close.action')}
        </Button>
        {state && (
          <small className="text-xs text-bambu-gray tabular-nums" data-testid="close-suggestion-issued">
            {t('orders.close.issuedLine', { issued: state.issued, ordered: state.ordered, held: state.held })}
          </small>
        )}
      </div>
    </div>
  );
}
