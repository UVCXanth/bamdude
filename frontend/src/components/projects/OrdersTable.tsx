import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { OrderListItem } from '../../api/client';
import { SortableHeader } from '../SortableHeader';
import { WorkshopPanel, WorkshopTableScroll } from '../workshop/WorkshopPanel';
import { PriorityBadge } from './PriorityBadge';
import { StageBadge } from './StageBadge';
import { OrderActionMenu } from './orderActions/OrderActionMenu';
import { toOrderRef } from './orderActions/orderRef';
import type { OrderActions } from './orderActions/useOrderActions';
import { LiveCounts } from './orderRow/LiveCounts';
import { OrderCoverage } from './orderRow/OrderCoverage';
import { OrderDue } from './orderRow/OrderDue';
import { OrderResponsible } from './orderRow/OrderResponsible';
import { ReadyEstimate } from './orderRow/ReadyEstimate';
import { readiness } from './orderRow/readiness';
import type { useOrdersForecast } from './orderRow/useOrdersForecast';

/** The keys the table's own headers sort by — every other key needs the toolbar's chip (D01). */
export const TABLE_SORT_KEYS = ['name', 'stage', 'progress', 'due', 'ready'] as const;

/**
 * The orders list as a table — the mockup's nine logical columns (WS-13 E7 D01):
 * order / customer, stage, coverage, print / queue, due, ready ≈, material,
 * responsible and the order menu. Ordered, printed, from stock, queued, left and
 * machine hours are no longer columns of their own: they live in the cells that
 * explain them.
 *
 * The rows are ONE PAGE of a server-sorted list, drawn in the order they came;
 * every sortable header asks the server (`sort_by`). `footer` (the page bar) is
 * drawn inside the same panel, under the rows and outside their horizontal
 * scroll (WS-13 E2 E02). Every figure is the server's (WS-01).
 */
export function OrdersTable({
  orders,
  forecast,
  sort,
  onSortChange,
  footer,
  actions,
}: {
  orders: OrderListItem[];
  /** The page's forecast batch (`useOrdersForecast`) — never one request per row. */
  forecast: Pick<ReturnType<typeof useOrdersForecast>, 'state' | 'byId'>;
  /** The list's `sort_by`, e.g. `updated-desc`. */
  sort: string;
  onSortChange: (sortBy: string) => void;
  footer?: ReactNode;
  /** The page's order action host (WS-13 E6 B01) — the row menu runs through it. */
  actions: OrderActions;
}) {
  const { t } = useTranslation();
  const header = (key: string, label: string, descFirst = false) => (
    <SortableHeader sortKey={key} label={label} sort={sort} onSort={onSortChange} descFirst={descFirst} />
  );
  const plain = (label: string) => <th className="font-normal px-3 py-2 text-left">{label}</th>;

  return (
    <WorkshopPanel flush footer={footer}>
      <WorkshopTableScroll label={t('orders.table.label')}>
        <table className="w-full text-sm">
          <thead className="text-xs text-bambu-gray bg-bambu-dark-secondary [&_th]:px-3 [&_th]:py-2">
            <tr>
              {header('name', t('orders.table.orderCustomer'))}
              {/* The stage replaces the status (spec workshop-order-stage, rule 30). */}
              {header('stage', t('orders.table.stage'))}
              {header('progress', t('orders.table.progress'), true)}
              {plain(t('orders.table.live'))}
              {header('due', t('orders.table.due'))}
              {header('ready', t('orders.table.readyApprox'))}
              {plain(t('orders.table.material'))}
              {plain(t('orders.table.responsible'))}
              <th className="w-[1%]" aria-label={t('orders.table.actions')}>
                <span className="sr-only">{t('orders.table.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr
                key={o.id}
                data-testid={`order-row-${o.id}`}
                className="border-t border-bambu-dark-tertiary text-white align-top hover:bg-bambu-dark-tertiary/30 [&>td]:px-3 [&>td]:py-2.5"
              >
                <td className="min-w-[12rem]">
                  <span className="block text-xs text-bambu-gray">{o.code}</span>
                  <Link to={`/projects/${o.id}`} className="font-medium hover:underline">
                    {o.name}
                  </Link>
                  <span className="block text-xs text-bambu-gray">
                    {o.customer_name ?? t('orders.list.noCustomer')} · {t('orders.card.lines', { count: o.lines_count })}
                  </span>
                </td>
                <td>
                  <span className="flex flex-wrap items-center gap-1">
                    <StageBadge stage={o.stage} status={o.status} />
                    <PriorityBadge priority={o.priority} />
                  </span>
                  {o.status === 'active' && o.issued_units > 0 && (
                    <span className="block text-xs text-bambu-gray mt-1 tabular-nums" data-testid={`order-${o.id}-issued`}>
                      {t('orders.row.issued', { issued: o.issued_units, ordered: o.ordered })}
                    </span>
                  )}
                </td>
                <td className="min-w-[10rem]">
                  <OrderCoverage order={o} variant="table" />
                </td>
                <td className="whitespace-nowrap">
                  <LiveCounts order={o} />
                </td>
                <td className="whitespace-nowrap">
                  <OrderDue order={o} variant="cell" />
                </td>
                <td className="whitespace-nowrap" data-testid={`order-${o.id}-ready`}>
                  <ReadyEstimate readiness={readiness(o, forecast.byId[o.id], forecast.state)} testId={`order-${o.id}-ready-value`} />
                </td>
                <td className="max-w-[12rem]">
                  {o.materials.length > 0 ? (
                    <span className="line-clamp-2 text-bambu-gray-light" title={o.materials.join(', ')}>
                      {o.materials.join(', ')}
                    </span>
                  ) : (
                    <span className="text-bambu-gray">—</span>
                  )}
                </td>
                <td className="whitespace-nowrap">
                  <OrderResponsible order={o} className="text-xs" />
                </td>
                <td className="w-[1%]">
                  <OrderActionMenu
                    order={toOrderRef(o)}
                    context="list"
                    actions={actions}
                    extra={{ order: o }}
                    testId={`order-${o.id}-menu`}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </WorkshopTableScroll>
    </WorkshopPanel>
  );
}
