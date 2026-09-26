import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, Clock } from 'lucide-react';
import { api } from '../../api/client';
import type { AttentionOrder, DeadlineOrder, EtaMark, OrderViewFilters } from '../../api/client';
import { Button } from '../Button';
import { formatDateTime, localDateKey } from '../../utils/date';
import type { DateFormat, TimeFormat } from '../../utils/date';
import { dayKeys, windowStart } from '../../utils/deadlineWindow';
import { ProgressBar } from './ProgressBar';
import { StageBadge } from './StageBadge';

const DAYS = 14;

interface OrdersDeadlinesProps {
  filters: OrderViewFilters;
  /** Whole weeks away from the current one — the URL's `week`. */
  week: number;
  onWeek: (week: number) => void;
}

/**
 * The deadlines board (spec workshop-order-views, rules 14–17): two weeks from
 * a Monday, each order on its deadline day with the forecast beside it, the
 * other orders' «ready ≈» marks on the day they land, and what needs attention
 * below. Every verdict — `late`, the reasons — is the server's; this only lays
 * the answer out by LOCAL day: a deadline is a date (its key is the date as
 * written), a forecast is an instant (its key is the browser's day of it).
 */
export function OrdersDeadlines({ filters, week, onWeek }: OrdersDeadlinesProps) {
  const { t } = useTranslation();
  const keys = dayKeys(windowStart(new Date(), week), DAYS);
  const start = keys[0];
  const today = localDateKey(new Date());

  const { data } = useQuery({
    // Under `projects`, so every order write re-reads it (`invalidateOrderViews`).
    queryKey: ['projects', 'deadlines', start, filters],
    queryFn: () => api.getOrderDeadlines({ start, days: DAYS, ...filters }),
  });
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings, staleTime: 60_000 });
  const timeFormat: TimeFormat = settings?.time_format || 'system';
  const dateFormat = (settings?.date_format || 'system') as DateFormat;
  const when = (iso: string) =>
    formatDateTime(iso, timeFormat, dateFormat, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  const dueByDay = groupBy(data?.due ?? [], (d) => (d.order.due_date ?? '').slice(0, 10));
  const marksByDay = groupBy(data?.eta_marks ?? [], (m) => localDateKey(m.eta));
  const dayLabel = (key: string) =>
    new Date(`${key}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <Button variant="secondary" onClick={() => onWeek(week - 1)} aria-label={t('orders.deadlines.previous')}>
          <ChevronLeft className="w-4 h-4" />
        </Button>
        <span className="text-sm text-white tabular-nums">
          {t('orders.deadlines.range', { from: dayLabel(keys[0]), to: dayLabel(keys[DAYS - 1]) })}
        </span>
        <Button variant="secondary" onClick={() => onWeek(week + 1)} aria-label={t('orders.deadlines.next')}>
          <ChevronRight className="w-4 h-4" />
        </Button>
        {week !== 0 && (
          <Button variant="secondary" onClick={() => onWeek(0)}>
            {t('orders.deadlines.today')}
          </Button>
        )}
      </div>

      {[keys.slice(0, 7), keys.slice(7)].map((row) => (
        <div key={row[0]} className="grid grid-cols-1 md:grid-cols-7 gap-2">
          {row.map((key) => {
            const weekday = new Date(`${key}T00:00:00`).getDay();
            const weekend = weekday === 0 || weekday === 6;
            return (
              <div
                key={key}
                data-testid={`deadline-day-${key}`}
                aria-current={key === today ? 'date' : undefined}
                className={`min-h-24 rounded-lg border p-2 space-y-1.5 ${
                  key === today ? 'border-bambu-green' : 'border-bambu-dark-tertiary'
                } ${weekend ? 'bg-bambu-dark' : 'bg-bambu-dark-secondary'}`}
              >
                <div className={`text-xs ${key === today ? 'text-bambu-green font-semibold' : 'text-bambu-gray'}`}>
                  {dayLabel(key)}
                </div>
                {(dueByDay.get(key) ?? []).map((d) => (
                  <DueCard key={d.order.id} due={d} when={when} />
                ))}
                {(marksByDay.get(key) ?? []).map((m) => (
                  <EtaMarkLink key={m.id} mark={m} when={when} />
                ))}
              </div>
            );
          })}
        </div>
      ))}

      {data && <Attention items={data.attention} when={when} />}
    </div>
  );
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    out.set(key, [...(out.get(key) ?? []), item]);
  }
  return out;
}

function DueCard({ due, when }: { due: DeadlineOrder; when: (iso: string) => string }) {
  const { t } = useTranslation();
  const { order, eta, late } = due;
  return (
    <Link
      to={`/projects/${order.id}`}
      className="block rounded-md border border-bambu-dark-tertiary bg-bambu-dark p-2 space-y-1 hover:border-bambu-green/50"
    >
      <span className="flex items-center justify-between gap-1 text-[11px] text-bambu-gray">
        {order.code}
        <StageBadge stage={order.stage} status={order.status} />
      </span>
      <span className="block text-xs font-medium text-white truncate">{order.name}</span>
      <ProgressBar value={order.covered_units} max={order.ordered} progress={order.progress} testId={`deadline-${order.id}-progress`} />
      {eta && (
        <span data-testid={`deadline-eta-${order.id}`} className={`block text-[11px] ${late ? 'text-red-500' : 'text-bambu-gray'}`}>
          {t('orders.deadlines.readyAt', { when: when(eta) })}
          {late && ` · ${t('orders.deadlines.late')}`}
        </span>
      )}
    </Link>
  );
}

function EtaMarkLink({ mark, when }: { mark: EtaMark; when: (iso: string) => string }) {
  const { t } = useTranslation();
  return (
    <Link
      to={`/projects/${mark.id}`}
      title={mark.name}
      className="flex items-center gap-1 text-[11px] text-bambu-gray hover:text-white"
    >
      <Clock className="w-3 h-3 flex-shrink-0" />
      <span className="truncate">{t('orders.deadlines.etaMark', { code: mark.code, when: when(mark.eta) })}</span>
    </Link>
  );
}

const REASON_CLASS: Record<AttentionOrder['reason'], string> = {
  overdue: 'bg-red-500/20 text-red-500',
  late_eta: 'bg-yellow-100 dark:bg-yellow-500/20 text-yellow-700 dark:text-yellow-400',
  no_due: 'bg-bambu-dark-tertiary text-bambu-gray',
};

function Attention({ items, when }: { items: AttentionOrder[]; when: (iso: string) => string }) {
  const { t } = useTranslation();
  return (
    <section className="space-y-2">
      <div>
        <h3 className="text-sm font-semibold text-white">{t('orders.deadlines.attention')}</h3>
        <p className="text-xs text-bambu-gray">{t('orders.deadlines.attentionHint')}</p>
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-bambu-gray">{t('orders.deadlines.empty')}</p>
      ) : (
        <ul aria-label={t('orders.deadlines.attention')} className="space-y-1">
          {items.map(({ order, reason, eta }) => (
            <li key={order.id} className="flex items-center gap-2 flex-wrap text-sm">
              <span className={`px-2 py-0.5 rounded text-xs font-medium ${REASON_CLASS[reason]}`}>
                {t(`orders.deadlines.reason.${reason}`)}
              </span>
              <Link to={`/projects/${order.id}`} className="text-white hover:underline">
                {order.code} · {order.name}
              </Link>
              {order.due_date && (
                <span className="text-xs text-bambu-gray">
                  {t('orders.deadlines.dueLabel')}: {new Date(order.due_date).toLocaleDateString()}
                </span>
              )}
              {eta && <span className="text-xs text-bambu-gray">{t('orders.deadlines.readyAt', { when: when(eta) })}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
