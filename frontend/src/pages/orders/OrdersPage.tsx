import { useEffect, useId, useRef, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Plus, X } from 'lucide-react';
import { api, ORDER_STAGES } from '../../api/client';
import type { OrderStage, OrderViewFilters, ProjectStatus } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { useOrderActions } from '../../components/projects/orderActions/useOrderActions';
import { FilamentStrip } from '../../components/projects/FilamentStrip';
import { OrdersTiles } from '../../components/projects/OrdersTiles';
import { OrderStatusTabs, OrdersListView } from '../../components/projects/OrdersListView';
import { OrdersBoard } from '../../components/projects/board/OrdersBoard';
import { OrdersWorkspace } from '../../components/projects/OrdersWorkspace';
import { OrdersDeadlines } from '../../components/projects/OrdersDeadlines';
import { ORDER_TABS, ORDERS_DEFAULT_SORT } from '../../components/projects/orderList';
import { useOrderSortOptions } from '../../hooks/useOrderSortOptions';
import { Button } from '../../components/Button';
import { Select } from '../../components/Select';
import { ListPageHeader } from '../../components/ListPageHeader';
import { ListSearchBox } from '../../components/ListSearchBox';
import { ListViewToggle } from '../../components/ListViewToggle';
import { ListSortControl } from '../../components/ListSortControl';
import { useOrdersViews } from '../../hooks/useOrdersViews';
import { useListUrlState } from '../../hooks/useListUrlState';
import { sectionParam } from '../../components/projects/orderSections';
import { parseOrdersView, parsePageSize, usePersistedState } from '../../hooks/usePersistedState';
import type { OrdersView } from '../../hooks/usePersistedState';
import { useSearchBox } from '../../hooks/useSearchBox';
import { WorkshopTabPanel } from '../../components/workshop/WorkshopTabs';

const GROUP_STORAGE_KEY = 'projects.groupByCustomer';
const VIEW_STORAGE_KEY = 'projects.view';
const PER_PAGE_STORAGE_KEY = 'projects.perPage';

/**
 * The order list: status tabs, a customer filter, a search and an optional
 * grouping — one page at a time from the server (spec projects-lists-parity).
 *
 * The tab counts are the server's `totals`: every filter but the status, so
 * the tabs tell the truth under the chosen customer or search without a
 * request per tab. The place in the list (tab, customer, search, sort, page)
 * lives in the URL; the view mode, the grouping and the page size are the
 * viewer's preferences. Grouping groups the PAGE — it is not a sort. The
 * default sort follows the view (`ORDERS_DEFAULT_SORT`). The cards, the table
 * and the page bar are `OrdersListView`, shared with the customer page.
 *
 * Five views (spec workshop-order-views): the table, the cards and the
 * workspace page through the list; the kanban and the deadlines ask their own
 * endpoints, so the tabs, the page bar and the list request are theirs to skip.
 * Search, customer and responsible filter every view alike.
 */
export function OrdersPage() {
  const { t } = useTranslation();
  const { hasPermission, user } = useAuth();

  // Nothing chosen (or nothing readable) → the table (WS-13 E2 B05, S03): its default
  // order is `due-asc`, so a URL without `sort` sorts by due date for such a reader.
  const [view, setViewPref] = usePersistedState<OrdersView>(VIEW_STORAGE_KEY, 'table', parseOrdersView);
  const tabsId = useId();
  const views = useOrdersViews();
  const sortOptions = useOrderSortOptions();
  const { page, q, sort, extra, setPage, setQ, setSort, setExtra, setExtras, resetFilters, clampToLastPage } = useListUrlState({
    defaults: { sort: ORDERS_DEFAULT_SORT[view], extra: { tab: 'active', customer: '', responsible: '', stage: '', order: '', section: '', week: '0' } },
  });
  // Another view is another default order, so the page it stood on means nothing there.
  const setView = (next: OrdersView) => {
    setViewPref(next);
    setPage(1);
  };
  const listLike = view === 'table' || view === 'cards';
  // The views that page through the list; the board and the deadlines never ask for it.
  const paged = listLike || view === 'workspace';
  // Only a stored stage counts: anything else in the URL is not a filter (the server would refuse it).
  const stage: OrderStage | '' = (ORDER_STAGES as readonly string[]).includes(extra.stage)
    ? (extra.stage as OrderStage)
    : '';
  // The deadlines' place: whole weeks from this one. Anything else is this week.
  const week = Number.isInteger(Number(extra.week)) ? Number(extra.week) : 0;
  const tab: ProjectStatus | 'all' = (ORDER_TABS as readonly string[]).includes(extra.tab)
    ? (extra.tab as ProjectStatus | 'all')
    : 'active';
  const customerId = extra.customer && Number.isInteger(Number(extra.customer)) ? Number(extra.customer) : null;
  // «Mine» stays `me` in the URL — a link means the same for whoever opens it —
  // and is resolved to the signed-in user's id only for the request.
  const responsibleId =
    extra.responsible === 'me'
      ? (user?.id ?? null)
      : extra.responsible && Number.isInteger(Number(extra.responsible))
        ? Number(extra.responsible)
        : null;
  const { typed, setTyped, forget } = useSearchBox(q, setQ);
  const [perPage, setPerPage] = usePersistedState<number>(PER_PAGE_STORAGE_KEY, 24, parsePageSize);
  const [groupByCustomer, setGroupByCustomer] = useState<boolean>(() => {
    try {
      return localStorage.getItem(GROUP_STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });
  // The order action host of the whole page (WS-13 E6 B01) — cards, board and the
  // workspace pane all run through it; its dialogs outlive the rows they were opened
  // from, and focus with nowhere to return lands on the page's heading.
  const heading = useRef<HTMLHeadingElement>(null);
  const { run, create, dialogs } = useOrderActions({ fallbackFocusRef: heading });
  const actions = { run, create };

  const viewFilters: OrderViewFilters = {
    ...(customerId != null ? { customer_id: customerId } : {}),
    ...(responsibleId != null ? { responsible_id: responsibleId } : {}),
    ...(q ? { q } : {}),
  };
  const params = {
    ...(tab !== 'all' ? { status: tab } : {}),
    ...viewFilters,
    ...(stage ? { stage } : {}),
    sort_by: sort,
    page,
    ...(perPage === -1 ? { all: true } : { per_page: perPage }),
  };
  const { data, isLoading, isPlaceholderData } = useQuery({
    queryKey: ['projects', params],
    queryFn: () => api.getOrdersPaged(params),
    enabled: paged,
    // The old page stays on screen while the next one loads — no skeleton flash.
    placeholderData: keepPreviousData,
  });
  const { data: customers = [] } = useQuery({ queryKey: ['customers'], queryFn: api.getCustomers });
  const { data: assignees = [] } = useQuery({ queryKey: ['order-assignees'], queryFn: api.getOrderAssignees });
  // A delete (ours or someone else's) can leave us past the last page. Only an
  // answer for THIS view may clamp: the previous page's, still on screen while
  // the next loads, knows nothing about how many pages the new filter has.
  useEffect(() => {
    if (data && !isPlaceholderData) clampToLastPage(data.meta.last_page);
  }, [data, isPlaceholderData, clampToLastPage]);

  const total = data?.meta.total ?? 0;
  // Every filter Reset clears — «Mine» with nothing of mine is a filter that
  // matched nothing, never «no orders yet» on a farm full of them.
  const filtered = q !== '' || customerId != null || extra.responsible !== '' || stage !== '';

  // The farm-wide filament strip over the list — every active order, not just the visible tab/filter.
  const filamentQuery = useQuery({ queryKey: ['orders-filament'], queryFn: api.getOrdersFilament, staleTime: 30_000 });

  const toggleGroupByCustomer = (value: boolean) => {
    setGroupByCustomer(value);
    try {
      localStorage.setItem(GROUP_STORAGE_KEY, value ? '1' : '0');
    } catch {
      // Private browsing / storage disabled — the toggle still works this session.
    }
  };

  return (
    <div className="workshop p-4">
      <ListPageHeader title={t('orders.list.title')} subtitle={t('orders.list.subtitle')} headingRef={heading}>
        <ListViewToggle value={view} options={views} onChange={setView} />
        {hasPermission('projects:create') && (
          <Button onClick={() => create(customerId)}>
            <Plus className="w-4 h-4" />
            {t('orders.list.newOrder')}
          </Button>
        )}
      </ListPageHeader>

      <OrdersTiles />

      {filamentQuery.data && (
        <div className="mb-4">
          <FilamentStrip farm={filamentQuery.data} />
        </div>
      )}

      <div className="flex items-center gap-4 mb-4 flex-wrap">
        {paged && (
          <OrderStatusTabs
            idBase={tabsId}
            tab={tab}
            totals={data?.totals}
            busy={isPlaceholderData}
            onChange={(key) => setExtra('tab', key)}
          />
        )}

        <ListSearchBox value={typed} onChange={setTyped} placeholder={t('orders.list.searchPlaceholder')} />

        <Select value={customerId ?? ''} onChange={(e) => setExtra('customer', e.target.value)}>
          <option value="">{t('orders.list.customerFilterAll')}</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>

        <Select
          aria-label={t('orders.list.responsible')}
          value={extra.responsible}
          onChange={(e) => setExtra('responsible', e.target.value)}
        >
          <option value="">{t('orders.list.responsibleAll')}</option>
          <option value="me">{t('orders.list.responsibleMine')}</option>
          {assignees.map((u) => (
            <option key={u.id} value={u.id}>
              {u.username}
            </option>
          ))}
          {/* A filter from the URL naming someone no longer offered (deactivated)
              still shows as the live filter, never as «All responsible». */}
          {responsibleId != null &&
            extra.responsible !== 'me' &&
            !assignees.some((u) => u.id === responsibleId) && (
              <option value={responsibleId}>{`#${responsibleId}`}</option>
            )}
        </Select>

        {listLike && (
          <label className="flex items-center gap-2 text-sm text-white cursor-pointer">
            <input
              type="checkbox"
              checked={groupByCustomer}
              onChange={(e) => toggleGroupByCustomer(e.target.checked)}
              className="accent-bambu-green"
              aria-label={t('orders.list.groupByCustomer')}
            />
            {t('orders.list.groupByCustomer')}
          </label>
        )}

        {/* A table sorts from its headers; the cards and the workspace's compact rows need a control of their own. */}
        {(view === 'cards' || view === 'workspace') && (
          <ListSortControl sort={sort} options={sortOptions} onChange={setSort} />
        )}

        {/* The kanban's «…and N more» lands here with the stage it came from (spec workshop-order-views, rule 9). */}
        {paged && stage && (
          <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-bambu-dark-tertiary text-xs text-white">
            {t('orders.list.stageChip', { stage: t(`orders.stage.${stage}`) })}
            <button type="button" aria-label={t('orders.list.stageChipRemove')} onClick={() => setExtra('stage', '')}>
              <X className="w-3 h-3" />
            </button>
          </span>
        )}
      </div>

      {/* The tab's panel is the list and its empty state — not the filters above it (WS-13 E2 C02). */}
      {paged && (
        <WorkshopTabPanel idBase={tabsId} value={tab}>
          {!isLoading && total === 0 && (
            filtered ? (
              <div className="flex items-center gap-3 text-bambu-gray text-sm">
                <span>{t('list.empty.noMatch')}</span>
                <Button
                  variant="secondary"
                  onClick={() => {
                    forget();
                    resetFilters(['tab']);
                  }}
                >
                  {t('list.empty.reset')}
                </Button>
              </div>
            ) : (
              <p className="text-bambu-gray text-sm">{t(`orders.list.empty.${tab}`)}</p>
            )
          )}

          {listLike && (
            <OrdersListView
              data={data}
              isLoading={isLoading}
              isPlaceholderData={isPlaceholderData}
              view={view}
              sort={sort}
              onSortChange={setSort}
              perPage={perPage}
              onPageChange={setPage}
              onPerPageChange={(n) => {
                setPerPage(n);
                setPage(1);
              }}
              groupByCustomer={groupByCustomer}
              actions={actions}
            />
          )}
          {view === 'workspace' && (
            <OrdersWorkspace
              data={data}
              isLoading={isLoading}
              isPlaceholderData={isPlaceholderData}
              perPage={perPage}
              onPageChange={setPage}
              onPerPageChange={(n) => {
                setPerPage(n);
                setPage(1);
              }}
              picked={Number(extra.order) || null}
              // Another order opens on its plan: the order and the tab in ONE write
              // (WS-13 E3 F03) — deleting the shown one clears both.
              onPick={(id) => setExtras({ order: id ? String(id) : '', section: '' }, { keepPage: true })}
              section={extra.section}
              // The shown order and its tab in ONE write — also when the order was
              // the first-row fallback and the URL did not name it yet (F03).
              onSection={(orderId, next) => setExtras({ order: String(orderId), section: sectionParam(next) }, { keepPage: true })}
              actions={actions}
            />
          )}
        </WorkshopTabPanel>
      )}
      {view === 'kanban' && (
        <OrdersBoard
          filters={viewFilters}
          actions={actions}
          onOpenList={() => setViewPref('table')}
          onReset={() => {
            forget();
            resetFilters(['tab']);
          }}
        />
      )}
      {view === 'deadlines' && (
        <OrdersDeadlines filters={viewFilters} week={week} onWeek={(n) => setExtra('week', String(n), { keepPage: true })} />
      )}

      {dialogs}
    </div>
  );
}
