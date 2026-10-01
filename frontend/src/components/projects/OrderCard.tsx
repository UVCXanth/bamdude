import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { OrderListItem } from '../../api/client';
import { StageBadge } from './StageBadge';
import { PriorityBadge } from './PriorityBadge';
import { OrderActionMenu } from './orderActions/OrderActionMenu';
import { toOrderRef } from './orderActions/orderRef';
import type { OrderActions } from './orderActions/useOrderActions';
import { OrderCoverage } from './orderRow/OrderCoverage';
import { OrderDue } from './orderRow/OrderDue';
import { OrderResponsible } from './orderRow/OrderResponsible';
import { OrderThumbs } from './orderRow/OrderThumbs';
import { ReadyEstimate } from './orderRow/ReadyEstimate';
import type { Readiness } from './orderRow/readiness';

interface OrderCardProps {
  order: OrderListItem;
  /** The page's order action host (WS-13 E6 B01) — the card's menu runs through it. */
  actions: OrderActions;
  /** «Ready ≈» — `readiness` over the page's forecast batch (WS-13 E7 B03 / E03). */
  readiness: Readiness;
}

/**
 * One order in the grid — the mockup's card (WS-13 E7 E02): a 3 px colour rail;
 * thumbnails, code and stage; the name; customer and priority; coverage; a 2×2
 * of due / ready ≈ / print·queue / left; and a footer with the responsible person
 * and the menu. Every figure is the server's (WS-01).
 *
 * ⚠️ **The link is an OVERLAY, not the card's wrapper.** A menu `<button>`
 * inside an `<a>` is invalid HTML and every item had to cancel the navigation
 * its click caused. The anchor covers the card from on top (`absolute inset-0`,
 * named by `aria-label`), and the menu sits above it (`relative z-10`).
 *
 * The card is a column whose footer is pushed to the bottom: cards of one row
 * are as tall as the tallest, and a missing field never lifts a footer.
 */
export function OrderCard({ order, actions, readiness }: OrderCardProps) {
  const { t } = useTranslation();

  return (
    <div
      data-testid={`order-${order.id}-card`}
      className="relative flex h-full flex-col rounded-xl bg-bambu-dark-secondary border border-bambu-dark-tertiary hover:border-bambu-green/50 overflow-hidden"
    >
      <div
        data-part="rail"
        className={`h-[3px] flex-shrink-0 ${order.color ? '' : 'bg-bambu-dark-tertiary'}`}
        style={order.color ? { backgroundColor: order.color } : undefined}
      />

      <div className="flex flex-1 flex-col p-4">
        <div data-part="top" className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1">
          <OrderThumbs order={order} />
          <span data-code className="flex-shrink-0 whitespace-nowrap text-xs text-bambu-gray">
            {order.code}
          </span>
          <span className="ml-auto flex-shrink-0">
            <StageBadge stage={order.stage} status={order.status} />
          </span>
        </div>

        <h3 data-part="name" className="text-base font-semibold text-white break-words">
          {order.name}
        </h3>
        <p data-part="customer" className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-bambu-gray">
          <span className="truncate">{order.customer_name ?? t('orders.list.noCustomer')}</span>
          <PriorityBadge priority={order.priority} />
        </p>

        <div data-part="coverage" className="mt-3">
          <OrderCoverage order={order} variant="card" />
        </div>

        <dl data-part="meta" className="my-3.5 grid grid-cols-2 gap-2.5 text-sm">
          <div className="min-w-0">
            <dt className="text-xs text-bambu-gray">{t('orders.table.due')}</dt>
            <dd className="text-white">
              <OrderDue order={order} variant="meta" />
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-bambu-gray">{t('orders.table.readyApprox')}</dt>
            <dd>
              <ReadyEstimate readiness={readiness} testId={`order-${order.id}-ready-value`} />
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-bambu-gray">{t('orders.table.live')}</dt>
            <dd
              className="tabular-nums text-white"
              aria-label={t('orders.row.live', { printing: order.prints_in_progress, queued: order.prints_queued })}
            >
              {order.prints_in_progress} / {order.prints_queued}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-bambu-gray">{t('orders.card.left')}</dt>
            <dd className="tabular-nums text-white">{t('orders.card.leftUnits', { count: order.remaining })}</dd>
          </div>
        </dl>

        <div data-part="footer" className="mt-auto flex items-center justify-between gap-2 border-t border-bambu-dark-tertiary pt-2.5">
          <OrderResponsible order={order} className="min-w-0 truncate text-xs text-bambu-gray" />
          {/* Above the overlay link, so the trigger is clickable at all. */}
          <div className="relative z-10 flex-shrink-0">
            <OrderActionMenu
              order={toOrderRef(order)}
              context="list"
              actions={actions}
              extra={{ order }}
              testId={`order-${order.id}-menu`}
            />
          </div>
        </div>
      </div>

      <Link
        to={`/projects/${order.id}`}
        aria-label={order.name}
        className="absolute inset-0 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green"
      />
    </div>
  );
}
