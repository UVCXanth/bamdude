import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import type { OrderListItem, OrderListPage, OrderListTotals, ProjectStatus } from '../../api/client';
import type { ListSortOption } from '../ListSortControl';
import type { ListView } from '../ListViewToggle';
import { PaginationBar } from '../PaginationBar';
import { OrderCard } from './OrderCard';
import { OrdersTable } from './OrdersTable';

/** The status tabs of an order list, in their order. */
export const ORDER_TABS: readonly (ProjectStatus | 'all')[] = ['active', 'completed', 'cancelled', 'all'];

/** Each view has its own default order (owner's ruling): the table is the
 *  deadline roll-up it always was, the cards are "what moved lately". An
 *  explicit `?sort=` applies to both. */
export const ORDERS_DEFAULT_SORT = { table: 'due-asc', cards: 'updated-desc' } as const;

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
function OrdersSkeleton() {
  const { t } = useTranslation();
  return (
    <div role="status" aria-busy="true" data-testid="orders-skeleton">
      <span className="sr-only">{t('common.loading')}</span>
      <div aria-hidden="true" className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(280px,1fr))]">
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

/** Every server key of the orders list, for the cards' sort control (the table sorts from its headers). */
export function useOrderSortOptions(): ListSortOption[] {
  const { t } = useTranslation();
  return [
    { key: 'updated', label: t('list.sort.updated'), descFirst: true },
    { key: 'created', label: t('list.sort.created'), descFirst: true },
    { key: 'name', label: t('orders.table.name') },
    { key: 'due', label: t('orders.table.due') },
    { key: 'priority', label: t('orders.modal.priority'), descFirst: true },
    { key: 'customer', label: t('orders.table.customer') },
    { key: 'progress', label: t('orders.table.progress'), descFirst: true },
    { key: 'remaining', label: t('orders.table.remaining'), descFirst: true },
    { key: 'printing', label: t('orders.table.printing'), descFirst: true },
    { key: 'queued', label: t('orders.table.queued'), descFirst: true },
    { key: 'ready', label: t('orders.table.readyAt') },
    { key: 'hours', label: t('orders.table.machineHours'), descFirst: true },
  ];
}

/** The status tabs; the counts are the server's `totals`, never the rows on screen. */
export function OrderStatusTabs({
  tab,
  totals,
  onChange,
}: {
  tab: ProjectStatus | 'all';
  totals: OrderListTotals | undefined;
  onChange: (tab: ProjectStatus | 'all') => void;
}) {
  const { t } = useTranslation();
  const counts = totals ?? { active: 0, completed: 0, cancelled: 0, all: 0 };
  const label = (key: ProjectStatus | 'all') => (key === 'all' ? t('orders.list.tabAll') : t(`orders.status.${key}`));
  return (
    <div role="tablist" className="flex gap-1 border-b border-bambu-dark-tertiary">
      {ORDER_TABS.map((key) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={tab === key}
          onClick={() => onChange(key)}
          className={`px-4 py-2 text-sm border-b-2 -mb-px transition-colors ${
            tab === key ? 'border-bambu-green text-white' : 'border-transparent text-bambu-gray hover:text-white'
          }`}
        >
          {label(key)} ({counts[key]})
        </button>
      ))}
    </div>
  );
}

export interface OrdersListViewProps {
  data: OrderListPage | undefined;
  isLoading: boolean;
  isPlaceholderData: boolean;
  view: ListView;
  sort: string;
  onSortChange: (sortBy: string) => void;
  perPage: number;
  onPageChange: (page: number) => void;
  onPerPageChange: (perPage: number) => void;
  /** Groups the PAGE by customer — not a sort. */
  groupByCustomer?: boolean;
  onEdit: (order: OrderListItem) => void;
  onDuplicate: (order: OrderListItem) => void;
  onSetStatus: (order: OrderListItem, status: ProjectStatus) => void;
  onDelete: (order: OrderListItem) => void;
}

/**
 * One page of orders as cards or a table, with its page bar — the orders page's
 * list, shared with the customer page so the two cannot drift (spec
 * workshop-lists, rule 17). The forecast batch is asked only in table view,
 * only for this page's active orders.
 */
export function OrdersListView({
  data,
  isLoading,
  isPlaceholderData,
  view,
  sort,
  onSortChange,
  perPage,
  onPageChange,
  onPerPageChange,
  groupByCustomer = false,
  onEdit,
  onDuplicate,
  onSetStatus,
  onDelete,
}: OrdersListViewProps) {
  const { t } = useTranslation();
  const visible = useMemo(() => data?.items ?? [], [data]);
  const total = data?.meta.total ?? 0;

  // Only ACTIVE orders are forecast: «closed = nothing is planned» is the
  // product rule everywhere else, and the endpoint answers a closed order with
  // an empty forecast — asking for one buys a row of nulls (spec Decision 9).
  const forecastIds = visible.filter((o) => o.status === 'active').map((o) => o.id);
  // The forecast is only meaningful in table view — cards don't show it, and
  // the farm-wide simulation isn't cheap enough to run on every tab.
  const forecastQuery = useQuery({
    queryKey: ['orders-forecast', forecastIds],
    queryFn: () => api.getOrdersForecast(forecastIds),
    enabled: view === 'table' && forecastIds.length > 0,
    staleTime: 30_000,
  });
  // `undefined` while loading — every cell reads «…». A FAILED fetch is its
  // own state, passed down as `forecastError`: mapping it to `{}` here made
  // every row read «No estimate», which means «the farm could not place this
  // order», and sent the operator looking for a scheduling problem that was
  // really a dead request.
  const forecasts = useMemo(() => {
    if (!forecastQuery.data) return undefined;
    return Object.fromEntries(forecastQuery.data.orders.map((f) => [f.project_id, f]));
  }, [forecastQuery.data]);

  if (isLoading) return <OrdersSkeleton />;

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
    <OrderCard
      key={order.id}
      order={order}
      onEdit={onEdit}
      onDuplicate={onDuplicate}
      onSetStatus={onSetStatus}
      onDelete={onDelete}
    />
  );

  return (
    // The previous page stays on screen while the next one loads — dimmed
    // and marked busy, so it is not read as the answer to the new question.
    <div
      data-testid="list-body"
      aria-busy={isPlaceholderData}
      className={`transition-opacity ${isPlaceholderData ? 'opacity-60' : ''}`}
    >
      {groups ? (
        <>
          <div className="space-y-4">
            {[...groups.entries()].map(([customerName, group]) => (
              <section key={customerName}>
                <h2 className="text-lg font-medium text-white mb-2">{customerName}</h2>
                {view === 'table' ? (
                  <OrdersTable
                    orders={group}
                    forecasts={forecasts}
                    forecastError={forecastQuery.isError}
                    sort={sort}
                    onSortChange={onSortChange}
                  />
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
            forecasts={forecasts}
            forecastError={forecastQuery.isError}
            sort={sort}
            onSortChange={onSortChange}
            footer={pageBar('card')}
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
