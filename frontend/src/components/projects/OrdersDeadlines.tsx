import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, Clock } from 'lucide-react';
import { api } from '../../api/client';
import type { AttentionOrder, DeadlineOrder, EtaMark, OrderViewFilters } from '../../api/client';
import { Button } from '../Button';
import { formatCalendarDate, formatDateTime, localDateKey } from '../../utils/date';
import { dayKeys, windowStart } from '../../utils/deadlineWindow';
import { etaFull } from '../../utils/forecast';
import { LoadFailedNote } from '../workshop/LoadFailedNote';
import { RefreshFailedNote } from '../workshop/RefreshFailedNote';
import { ProgressBar } from './ProgressBar';
import { StageBadge } from './StageBadge';
import { EstimateWarning } from './orderRow/EstimateWarning';
import { dueLabel, etaLabel, useDateSettings } from './orderRow/useDateSettings';

const DAYS = 14;

interface OrdersDeadlinesProps {
  filters: OrderViewFilters;
  /** Whole weeks away from the current one — the URL's `week`. */
  week: number;
  onWeek: (week: number) => void;
}

/** The parts of a `YYYY-MM-DD` key — a calendar day, read without any timezone. */
function partsOf(key: string): { y: number; m: number; d: number } {
  const [y, m, d] = key.split('-').map(Number);
  return { y, m, d };
}

/**
 * The deadlines board (spec workshop-order-views, rules 14–17; WS-13 E7 H): two
 * weeks from a Monday as ONE 7×2 grid, each order on its deadline day with the
 * forecast beside it, the other orders' «ready ≈» marks on the day they land,
 * and what needs attention below. Every verdict — `late`, the reasons, the
 * estimate's completeness — is the server's; this only lays the answer out by
 * LOCAL day (rule 17): a deadline is a date (its key is the date as written), a
 * forecast is an instant (its key is the browser's day of it).
 */
export function OrdersDeadlines({ filters, week, onWeek }: OrdersDeadlinesProps) {
  const { t } = useTranslation();
  const keys = dayKeys(windowStart(new Date(), week), DAYS);
  const start = keys[0];
  const today = localDateKey(new Date());
  const { dateFormat, timeFormat } = useDateSettings();

  const { data, isError, isPlaceholderData, refetch } = useQuery({
    // Under `projects`, so every order write re-reads it (`invalidateOrderViews`).
    queryKey: ['projects', 'deadlines', start, filters],
    queryFn: () => api.getOrderDeadlines({ start, days: DAYS, ...filters }),
    // The previous fortnight stays (dimmed) while the next week or filter is asked.
    placeholderData: keepPreviousData,
  });

  const dueByDay = groupBy(data?.due ?? [], (d) => (d.order.due_date ?? '').slice(0, 10));
  const marksByDay = groupBy(data?.eta_marks ?? [], (m) => localDateKey(m.eta));
  // The weekday and the month are words, not a date format: the user's setting is for dates.
  const weekday = (key: string) => formatCalendarDate(key, { weekday: 'short' }, 'system');
  const month = (key: string) => formatCalendarDate(key, { month: 'short' }, 'system');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={() => onWeek(week - 1)} aria-label={t('orders.deadlines.previous')}>
            <ChevronLeft className="w-4 h-4" aria-hidden="true" />
            <span className="max-[560px]:hidden">{t('orders.deadlines.previous')}</span>
          </Button>
          <b data-testid="deadlines-range" className="text-sm text-white tabular-nums">
            {t('orders.deadlines.range', { from: dueLabel(keys[0], dateFormat), to: dueLabel(keys[DAYS - 1], dateFormat) })}
          </b>
          <Button variant="secondary" onClick={() => onWeek(week + 1)} aria-label={t('orders.deadlines.next')}>
            <span className="max-[560px]:hidden">{t('orders.deadlines.next')}</span>
            <ChevronRight className="w-4 h-4" aria-hidden="true" />
          </Button>
          {week !== 0 && (
            <Button variant="ghost" onClick={() => onWeek(0)}>
              {t('orders.deadlines.today')}
            </Button>
          )}
        </div>
        <small data-testid="deadlines-legend" className="inline-flex flex-wrap items-center gap-1 text-xs text-bambu-gray">
          {t('orders.deadlines.legendCard')}
          <Clock className="w-3 h-3" aria-hidden="true" />
          {t('orders.deadlines.legendEta')}
        </small>
      </div>

      {/* A failed read with nothing to show is said out loud: an empty fortnight would read as «nothing due». */}
      {isError && !data && <LoadFailedNote message={t('orders.deadlines.loadFailed')} onRetry={() => void refetch()} />}
      {isError && data && <RefreshFailedNote onRetry={() => void refetch()} />}

      {/* WS-13 E7 H05: one panel, two week rows of seven, its own horizontal scroll (geometry of WS-13).
          ⚠️ `relative`: a positioned scroll box, or an absolutely positioned descendant (the
          sr-only «late» of a card) escapes its clipping and widens the whole page on a phone. */}
      <div
        role="region"
        aria-label={t('orders.deadlines.calendar')}
        tabIndex={0}
        aria-busy={isPlaceholderData}
        className={`relative overflow-x-auto rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green transition-opacity ${
          isPlaceholderData ? 'opacity-60' : ''
        }`}
      >
        {[keys.slice(0, 7), keys.slice(7)].map((row, rowIndex) => (
          <div
            key={row[0]}
            data-week-row
            className={`grid grid-cols-[repeat(7,minmax(140px,1fr))] ${rowIndex > 0 ? 'border-t border-bambu-dark-tertiary' : ''}`}
          >
            {row.map((key) => {
              const { y, m, d } = partsOf(key);
              const dow = new Date(y, m - 1, d).getDay();
              const weekend = dow === 0 || dow === 6;
              const isToday = key === today;
              return (
                <section
                  key={key}
                  data-testid={`deadline-day-${key}`}
                  aria-current={isToday ? 'date' : undefined}
                  aria-label={dueLabel(key, dateFormat)}
                  className={`min-h-[180px] p-2.5 space-y-2 border-r border-bambu-dark-tertiary last:border-r-0 ${weekend ? 'bg-bambu-dark' : ''}`}
                >
                  <header className="flex items-baseline gap-1.5">
                    <small className="text-xs text-bambu-gray">{weekday(key)}</small>
                    <b className={`text-xl tabular-nums ${isToday ? 'text-bambu-green' : 'text-white'}`}>{d}</b>
                    <small className={`text-xs ${isToday ? 'text-bambu-green' : 'text-bambu-gray'}`}>
                      {isToday ? t('orders.deadlines.today') : month(key)}
                    </small>
                  </header>
                  {(dueByDay.get(key) ?? []).map((due) => (
                    <DueCard key={due.order.id} due={due} />
                  ))}
                  {(marksByDay.get(key) ?? []).map((mark) => (
                    <EtaMarkLink
                      key={mark.id}
                      mark={mark}
                      time={formatDateTime(mark.eta, timeFormat, 'system', { hour: '2-digit', minute: '2-digit' })}
                      full={etaFull(mark.eta, timeFormat, dateFormat)}
                    />
                  ))}
                </section>
              );
            })}
          </div>
        ))}
      </div>

      {data && <Attention items={data.attention} />}
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

/**
 * An order on its deadline day (WS-13 E7 H06). The risk frame follows the
 * server's `late` and nothing else — the client draws no conclusion of its own
 * from two dates.
 */
function DueCard({ due }: { due: DeadlineOrder }) {
  const { t } = useTranslation();
  const { dateFormat } = useDateSettings();
  const { order, eta, late } = due;
  const reasons = due.estimate_reasons ?? [];
  const active = order.status === 'active';
  return (
    <Link
      to={`/projects/${order.id}`}
      data-risk={late ? 'true' : undefined}
      style={order.color && !late ? { borderLeftColor: order.color } : undefined}
      className={`block rounded-lg border border-l-[3px] p-2.5 space-y-1 hover:border-bambu-green/50 ${
        late
          ? 'border-red-500/50 border-l-red-500 bg-red-500/[0.08]'
          : `border-bambu-dark-tertiary bg-bambu-dark ${order.color ? '' : 'border-l-bambu-dark-tertiary'}`
      }`}
    >
      <small className="block text-[11px] text-bambu-gray">{t('orders.deadlines.cardCode', { code: order.code })}</small>
      <strong className="block text-xs font-semibold text-white line-clamp-2">{order.name}</strong>
      <small className="block truncate text-[11px] text-bambu-gray">{order.customer_name ?? t('orders.list.noCustomer')}</small>
      <ProgressBar
        value={order.covered_units}
        max={order.ordered}
        progress={order.progress}
        caption="both"
        testId={`deadline-${order.id}-progress`}
      />
      <StageBadge stage={order.stage} status={order.status} />
      {active &&
        (order.remaining <= 0 && !eta ? (
          // Nothing left to cover: the lists' word (B03), not «no estimate».
          <span data-testid={`deadline-eta-${order.id}`} className="block text-[11px] text-bambu-green">
            {t('orders.row.allCovered')}
          </span>
        ) : eta ? (
          <span
            data-testid={`deadline-eta-${order.id}`}
            className={`flex items-center text-[11px] ${late ? 'text-red-500' : 'text-bambu-green'}`}
          >
            {t('orders.deadlines.readyAt', { when: etaLabel(eta, dateFormat) })}
            {late && <span className="sr-only"> ({t('orders.deadlines.late')})</span>}
            <EstimateWarning reasons={reasons} />
          </span>
        ) : reasons.length > 0 ? (
          <span data-testid={`deadline-eta-${order.id}`} className="flex items-center text-[11px] text-amber-400">
            {t('orders.row.incomplete')}
            <EstimateWarning reasons={reasons} />
          </span>
        ) : (
          <span data-testid={`deadline-eta-${order.id}`} className="block text-[11px] text-bambu-gray">
            {t('orders.row.noEstimate')}
          </span>
        ))}
    </Link>
  );
}

function EtaMarkLink({ mark, time, full }: { mark: EtaMark; time: string; full: string }) {
  const { t } = useTranslation();
  return (
    <Link
      to={`/projects/${mark.id}`}
      title={t('orders.deadlines.etaMarkTitle', { when: full })}
      className="flex items-center gap-1 rounded-md border border-dashed border-bambu-dark-tertiary px-2 py-1 text-[11px] text-bambu-gray hover:text-white"
    >
      <Clock className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
      <span className="truncate">{t('orders.deadlines.etaMark', { code: mark.code, when: time })}</span>
    </Link>
  );
}

const BADGE_CLASS: Record<AttentionOrder['reason'], string> = {
  overdue: 'bg-red-500/20 text-red-500',
  late_eta: 'bg-amber-400/15 text-amber-300',
  partial: 'bg-amber-400/15 text-amber-300',
  no_due: 'bg-bambu-dark-tertiary text-bambu-gray',
};

/** The server's reason for one order, in the mockup's words (WS-13 E7 H08). */
function ReasonBadge({ item }: { item: AttentionOrder }) {
  const { t } = useTranslation();
  const { dateFormat } = useDateSettings();
  const due = dueLabel(item.order.due_date, dateFormat);
  const text =
    item.reason === 'late_eta'
      ? t('orders.deadlines.badge.late_eta', { eta: item.eta ? etaLabel(item.eta, dateFormat) : '—', due })
      : item.reason === 'partial'
        ? t('orders.deadlines.badge.partial', { due })
        : t(`orders.deadlines.badge.${item.reason}`);
  return (
    <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${BADGE_CLASS[item.reason]}`}>
      {text}
      {item.reason === 'partial' && <EstimateWarning reasons={item.estimate_reasons ?? []} />}
    </span>
  );
}

function Attention({ items }: { items: AttentionOrder[] }) {
  const { t } = useTranslation();
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-base font-semibold text-white">{t('orders.deadlines.attention')}</h2>
        <small className="text-xs text-bambu-gray">{t('orders.deadlines.attentionHint')}</small>
      </div>
      <div className="rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary">
        {items.length === 0 ? (
          <div className="px-4 py-6 text-center">
            <p className="text-sm font-medium text-white">{t('orders.deadlines.noRisks')}</p>
            <p className="text-xs text-bambu-gray">{t('orders.deadlines.noRisksBody')}</p>
          </div>
        ) : (
          <ul aria-label={t('orders.deadlines.attention')}>
            {items.map((item) => (
              <li
                key={item.order.id}
                className="flex flex-wrap items-center justify-between gap-2 border-t border-bambu-dark-tertiary px-4 py-3 first:border-t-0"
              >
                <div className="min-w-0">
                  <Link to={`/projects/${item.order.id}`} className="block truncate text-sm text-white hover:underline">
                    {item.order.code} · {item.order.name}
                  </Link>
                  <small className="block truncate text-xs text-bambu-gray">
                    {item.order.customer_name ?? t('orders.list.noCustomer')}
                  </small>
                </div>
                <ReasonBadge item={item} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
