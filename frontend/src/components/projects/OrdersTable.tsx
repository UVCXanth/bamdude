import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import type { OrderForecast, OrderListItem } from '../../api/client';
import { SortableHeader } from '../SortableHeader';
import { ProgressBar } from './ProgressBar';
import { StatusBadge } from './StatusBadge';
import { ForecastHint } from './ForecastHint';
import { etaFull, etaShort, hoursMinutes } from '../../utils/forecast';
import { isOverdue } from '../../utils/orderDates';

/**
 * The orders list as a table — the farm's roll-up (spec 2026-09-06, Slice F).
 * Every number is the server's.  In particular, `remaining` is the sum of
 * per-line deficits, so production surplus for one product cannot mask a
 * shortage in another.
 *
 * The rows are ONE PAGE of a server-sorted list, drawn in the order they came.
 * Every sortable column asks the server (`sort_by`) — the two forecast columns
 * included, which the server sorts by one simulation walk over the filtered
 * active orders (spec workshop-lists, rule 14). A fresh click on a count sorts
 * most-first; name, customer, due and «ready» start ascending. `footer` (the
 * page bar) is drawn inside the same card, under the rows.
 */
export function OrdersTable({
  orders,
  forecasts,
  forecastError,
  sort,
  onSortChange,
  footer,
}: {
  orders: OrderListItem[];
  forecasts?: Record<number, OrderForecast>;
  /** The list's `sort_by`, e.g. `updated-desc`. */
  sort: string;
  onSortChange: (sortBy: string) => void;
  footer?: ReactNode;
  /** The batch fetch failed or was refused — three distinct states share these
   *  two cells, and only one of them is about the farm: «…» is still loading,
   *  «No estimate» means the simulation could place nothing, and a dash with
   *  the error hint means we never got an answer to read. */
  forecastError?: boolean;
}) {
  const { t } = useTranslation();
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings, staleTime: 60_000 });
  const header = (key: string, label: string, descFirst = false) => (
    <SortableHeader sortKey={key} label={label} sort={sort} onSort={onSortChange} descFirst={descFirst} />
  );

  return (
    <div className="rounded-xl border border-bambu-dark-tertiary overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-bambu-gray bg-bambu-dark-secondary">
            <tr>
              {header('name', t('orders.table.name'))}
              {header('customer', t('orders.table.customer'))}
              <th className="font-normal p-2 text-left">{t('orders.table.status')}</th>
              <th className="font-normal p-2 text-right">{t('orders.table.ordered')}</th>
              <th className="font-normal p-2 text-right">{t('orders.table.printed')}</th>
              <th className="font-normal p-2 text-right">{t('orders.table.fromStock')}</th>
              {header('printing', t('orders.table.printing'), true)}
              {header('queued', t('orders.table.queued'), true)}
              {header('remaining', t('orders.table.remaining'), true)}
              {header('progress', t('orders.table.progress'), true)}
              {header('due', t('orders.table.due'))}
              {header('ready', t('orders.table.readyAt'))}
              {header('hours', t('orders.table.machineHours'), true)}
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
                <tr key={o.id} className="border-t border-bambu-dark-tertiary text-white">
                  <td className="p-2">
                    <Link to={`/projects/${o.id}`} className="hover:underline">{o.name}</Link>
                    <div className="text-xs text-bambu-gray">{o.code}</div>
                  </td>
                  <td className="p-2 text-bambu-gray">{o.customer_name ?? ''}</td>
                  <td className="p-2"><StatusBadge status={o.status} /></td>
                  <td className="p-2 text-right tabular-nums">{o.ordered}</td>
                  <td className="p-2 text-right tabular-nums">{o.printed}</td>
                  <td className="p-2 text-right tabular-nums">{o.from_stock_units}</td>
                  <td className="p-2 text-right tabular-nums" data-testid={`order-${o.id}-printing`}>{o.prints_in_progress}</td>
                  <td className="p-2 text-right tabular-nums" data-testid={`order-${o.id}-queued`}>{o.prints_queued}</td>
                  <td className="p-2 text-right tabular-nums">{o.remaining}</td>
                  <td className="p-2 min-w-[8rem]"><ProgressBar value={o.covered_units} max={o.ordered} progress={o.progress} testId={`order-${o.id}-table-progress`} /></td>
                  <td data-testid={`order-${o.id}-due`} className={`p-2 text-xs ${isOverdue(o) ? 'text-red-500' : 'text-bambu-gray'}`}>{o.due_date ? new Date(o.due_date).toLocaleDateString() : ''}</td>
                  <td className="p-2 text-xs whitespace-nowrap" data-testid={`order-${o.id}-ready`}>
                    {forecastError ? (
                      <span title={t('farmForecast.error')}>—</span>
                    ) : o.status !== 'active' ? (
                      // Closed = nothing is planned, so there is nothing to date.
                      '—'
                    ) : !forecasts ? (
                      '…'
                    ) : !forecasts[o.id]?.eta_complete ? (
                      t('orders.figures.readyIncomplete')
                    ) : !forecasts[o.id]?.now_eta ? (
                      t('farmForecast.unavailable')
                    ) : (
                      <>
                        <span title={etaFull(forecasts[o.id].now_eta, settings?.time_format, settings?.date_format)}>
                          {etaShort(forecasts[o.id].now_eta, settings?.time_format)}
                        </span>{' '}
                        <ForecastHint forecast={forecasts[o.id]} />
                        {forecasts[o.id].after_eta && forecasts[o.id].after_eta !== forecasts[o.id].now_eta && (
                          <div className="text-bambu-gray" data-testid={`order-${o.id}-after`}>
                            {t('orders.figures.afterAhead', { count: forecasts[o.id].ahead_count, when: etaShort(forecasts[o.id].after_eta, settings?.time_format) })}
                          </div>
                        )}
                      </>
                    )}
                  </td>
                  <td className="p-2 text-right tabular-nums" data-testid={`order-${o.id}-machine-hours`}>
                    {forecastError ? (
                      <span title={t('farmForecast.error')}>—</span>
                    ) : o.status !== 'active' ? (
                      '—'
                    ) : forecasts ? (
                      hoursMinutes(forecasts[o.id]?.machine_seconds)
                    ) : (
                      '…'
                    )}
                  </td>
                </tr>
            ))}
          </tbody>
        </table>
      </div>
      {footer}
    </div>
  );
}
