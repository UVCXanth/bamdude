import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { OrderListItem, OrderListPage, OrderListTotals, ProjectStatus } from '../../api/client';
import type { ListView } from '../ListViewToggle';
import { PaginationBar } from '../PaginationBar';
import { OrderCard } from './OrderCard';
import type { OrderActions } from './orderActions/useOrderActions';
import { OrdersTable } from './OrdersTable';
import { ORDER_TABS } from './orderList';
import { WorkshopTabs } from '../workshop/WorkshopTabs';
import { LoadFailedNote } from '../workshop/LoadFailedNote';
import { RefreshFailedNote } from '../workshop/RefreshFailedNote';
import { listState } from './orderRow/listState';
import { useOrdersForecast } from './orderRow/useOrdersForecast';

/** How many placeholder cards the first fetch draws. Enough to fill the top of
 *  a normal window without pretending to know how many orders there are. */
const SKELETON_CARDS = 6;

/**
 * The grid while the FIRST fetch is in flight.
 *
 * ⚠️ **`isLoading`, never `isFetching`.** A background refetch — every order
 * mutation invalidates `['projects']` — still has the orders on screen, and
 * replacing them with grey boxes for a moment is worse than showing figures
 * that are one request old. TanStack's `isLoading` is exactly "pending with no
 * data", which is the only state that has nothing to show.
 *
 * ⚠️ **The grey boxes are decoration; the STATUS is the sentence.** A grid of
 * `aria-hidden` placeholders is silence to a screen reader — the page reads as
 * having no orders, with nothing said about why. `role="status"` + `aria-busy`
 * on the wrapper, with one visually-hidden line inside, is what announces the
 * wait; the cards keep their `aria-hidden` so nobody hears six empty ones.
 */
function OrdersSkeleton({ view }: { view: ListView }) {
  const { t } = useTranslation();
  // WS-13 E7 C05: the wait is shaped like what comes — a table waits as a table.
  if (view === 'table') {
    return (
      <div role="status" aria-busy="true" data-testid="orders-skeleton" data-shape="table">
        <span className="sr-only">{t('common.loading')}</span>
        <div aria-hidden="true" className="rounded-xl bg-bambu-dark-secondary border border-bambu-dark-tertiary overflow-hidden">
          <div className="h-9 bg-bambu-dark-tertiary/50" />
          {Array.from({ length: SKELETON_CARDS }, (_, i) => (
            <div key={i} className="animate-pulse flex items-center gap-4 px-3 py-3 border-t border-bambu-dark-tertiary">
              <div className="h-4 w-1/4 rounded bg-bambu-dark" />
              <div className="h-4 w-16 rounded bg-bambu-dark" />
              <div className="h-2 w-40 rounded bg-bambu-dark" />
              <div className="h-4 w-20 rounded bg-bambu-dark" />
              <div className="h-4 w-24 rounded bg-bambu-dark" />
            </div>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div role="status" aria-busy="true" data-testid="orders-skeleton" data-shape="cards">
      <span className="sr-only">{t('common.loading')}</span>
      <div aria-hidden="true" className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(min(300px,100%),1fr))]">
        {Array.from({ length: SKELETON_CARDS }, (_, i) => (
          <div
            key={i}
            className="animate-pulse rounded-xl bg-bambu-dark-secondary border border-bambu-dark-tertiary overflow-hidden"
          >
            <div className="h-1.5 bg-bambu-dark-tertiary" />
            <div className="p-4 flex gap-3">
              <div className="w-20 h-20 flex-shrink-0 rounded-lg bg-bambu-dark" />
              <div className="flex-1 space-y-2 py-1">
                <div className="h-4 w-2/3 rounded bg-bambu-dark" />
                <div className="h-3 w-1/3 rounded bg-bambu-dark" />
                <div className="h-2 w-full rounded bg-bambu-dark" />
                <div className="h-3 w-1/4 rounded bg-bambu-dark" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** `Map` (not a plain object) so the group order matches first appearance in
 *  the already-filtered list, rather than an object's own key-insertion
 *  quirks with numeric-looking names. */
function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const existing = groups.get(key);
    if (existing) existing.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

/** The status tabs; the counts are the server's `totals`, never the rows on screen. */
export function OrderStatusTabs({
  idBase,
  tab,
  totals,
  busy = false,
  onChange,
}: {
  /** Shared with the `WorkshopTabPanel` around the list this strip controls. */
  idBase: string;
  tab: ProjectStatus | 'all';
  totals: OrderListTotals | undefined;
  /** The totals on screen belong to the previous request (placeholder data). */
  busy?: boolean;
  onChange: (tab: ProjectStatus | 'all') => void;
}) {
  const { t } = useTranslation();
  const label = (key: ProjectStatus | 'all') => (key === 'all' ? t('orders.list.tabAll') : t(`orders.status.${key}`));
  // ⚠️ No totals yet is «not known», never a zero (WS-13 E2 C05) — the strip
  // shows «(—)» until the server has counted.
  const items = ORDER_TABS.map((key) => ({ value: key, label: label(key), count: totals ? totals[key] : null }));
  return (
    <WorkshopTabs
      idBase={idBase}
      ariaLabel={t('orders.list.statusTabs')}
      value={tab}
      items={items}
      busy={busy}
      onChange={onChange}
    />
  );
}

export interface OrdersListViewProps {
  data: OrderListPage | undefined;
  /** The CURRENT key failed (WS-13 E7 C05): with no rows of its own an alert, with rows a note. */
  isError: boolean;
  /** Reads the current key again. */
  onRetry: () => void;
  isPlaceholderData: boolean;
  view: ListView;
  sort: string;
  onSortChange: (sortBy: string) => void;
  perPage: number;
  onPageChange: (page: number) => void;
  onPerPageChange: (perPage: number) => void;
  /** Groups the PAGE by customer — not a sort. */
  groupByCustomer?: boolean;
  /** The page's order action host (WS-13 E6 B01) — handed to every card. */
  actions: OrderActions;
}

/**
 * One page of orders as cards or a table, with its page bar — the orders page's
 * list, shared with the customer page so the two cannot drift (spec
 * workshop-lists, rule 17). The forecast is asked in batches for the page's rows
 * that still need one (WS-13 E7 B04) — table and cards both show «Ready ≈».
 */
export function OrdersListView({
  data,
  isError,
  onRetry,
  isPlaceholderData,
  view,
  sort,
  onSortChange,
  perPage,
  onPageChange,
  onPerPageChange,
  groupByCustomer = false,
  actions,
}: OrdersListViewProps) {
  const { t } = useTranslation();
  const visible = useMemo(() => data?.items ?? [], [data]);
  const total = data?.meta.total ?? 0;

  // ⚠️ A FAILED forecast is its own state (a dash and one retry), never «no
  // estimate» — that means «the farm could not place this order» and would send
  // the operator hunting a scheduling problem that is really a dead request.
  const forecast = useOrdersForecast(visible, view === 'table' || view === 'cards');

  const state = listState({ data, isError, isPlaceholderData });
  if (state === 'loading') return <OrdersSkeleton view={view} />;
  // A new page, filter or customer that failed has no rows of its own — never another key's.
  if (state === 'failed') return <LoadFailedNote message={t('orders.list.loadFailed')} onRetry={onRetry} />;
  // The page draws its own empty state (it knows whether a filter holds).
  if (state === 'empty') return null;

  const groups = groupByCustomer ? groupBy(visible, (o) => o.customer_name ?? t('orders.list.noCustomer')) : null;

  const pageBar = (variant: 'card' | 'bare') =>
    data ? (
      <PaginationBar
        page={data.meta.current_page}
        totalPages={data.meta.last_page}
        perPage={perPage}
        total={total}
        onPageChange={onPageChange}
        onPerPageChange={onPerPageChange}
        items={t('orders.list.items', { count: total })}
        variant={variant}
      />
    ) : null;

  const renderCard = (order: OrderListItem) => (
    <OrderCard key={order.id} order={order} actions={actions} />
  );

  return (
    // The previous page stays on screen while the next one loads — dimmed
    // and marked busy, so it is not read as the answer to the new question.
    <div
      data-testid="list-body"
      aria-busy={isPlaceholderData}
      className={`transition-opacity ${isPlaceholderData ? 'opacity-60' : ''}`}
    >
      {state === 'refresh-failed' && <RefreshFailedNote onRetry={onRetry} />}
      {forecast.state === 'error' && (
        <LoadFailedNote role="status" className="mb-2 text-xs" message={t('orders.row.forecastFailed')} onRetry={forecast.refetch} />
      )}
      {groups ? (
        <>
          <div className="space-y-4">
            {[...groups.entries()].map(([customerName, group]) => (
              <section key={customerName}>
                {/* The group's rows ON THIS PAGE — grouping groups the page, never the list (WS-01). */}
                <h3 className="text-sm font-semibold text-white mb-2">
                  {customerName}{' '}
                  <small
                    className="text-xs font-normal text-bambu-gray tabular-nums"
                    aria-label={t('orders.list.groupCount', { count: group.length })}
                  >
                    {group.length}
                  </small>
                </h3>
                {view === 'table' ? (
                  <OrdersTable orders={group} forecast={forecast} sort={sort} onSortChange={onSortChange} actions={actions} />
                ) : (
                  <div className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(280px,1fr))]">{group.map(renderCard)}</div>
                )}
              </section>
            ))}
          </div>
          {/* Several tables, one bar — it belongs to the page, not to a group. */}
          {total > 0 && <div className="mt-4">{pageBar('bare')}</div>}
        </>
      ) : view === 'table' ? (
        total > 0 && (
          <OrdersTable
            orders={visible}
            forecast={forecast}
            sort={sort}
            onSortChange={onSortChange}
            footer={pageBar('card')}
            actions={actions}
          />
        )
      ) : (
        <>
          <div className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(280px,1fr))]">{visible.map(renderCard)}</div>
          {total > 0 && <div className="mt-4">{pageBar('bare')}</div>}
        </>
      )}
    </div>
  );
}
