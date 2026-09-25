import { useEffect, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { api } from '../../api/client';
import type { OrderListItem, ProjectStatus } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { ProjectsTabs } from '../../components/projects/ProjectsTabs';
import { OrderModal } from '../../components/projects/OrderModal';
import { FilamentStrip } from '../../components/projects/FilamentStrip';
import { OrdersTiles } from '../../components/projects/OrdersTiles';
import {
  ORDER_TABS,
  ORDERS_DEFAULT_SORT,
  OrderStatusTabs,
  OrdersListView,
  useOrderSortOptions,
} from '../../components/projects/OrdersListView';
import { ConfirmModal } from '../../components/ConfirmModal';
import { Button } from '../../components/Button';
import { Select } from '../../components/Select';
import { ListPageHeader } from '../../components/ListPageHeader';
import { ListSearchBox } from '../../components/ListSearchBox';
import { ListViewToggle } from '../../components/ListViewToggle';
import { ListSortControl } from '../../components/ListSortControl';
import type { ListView } from '../../components/ListViewToggle';
import { useCardsTableViews } from '../../hooks/useCardsTableViews';
import { useListUrlState } from '../../hooks/useListUrlState';
import { parseListView, parsePageSize, usePersistedState } from '../../hooks/usePersistedState';
import { useSearchBox } from '../../hooks/useSearchBox';
import { invalidateAfterDelete, invalidateOrderViews } from '../../utils/queryInvalidation';

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
 */
export function OrdersPage() {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [view, setViewPref] = usePersistedState<ListView>(VIEW_STORAGE_KEY, 'cards', parseListView);
  const views = useCardsTableViews();
  const sortOptions = useOrderSortOptions();
  const { page, q, sort, extra, setPage, setQ, setSort, setExtra, resetFilters, clampToLastPage } = useListUrlState({
    defaults: { sort: ORDERS_DEFAULT_SORT[view], extra: { tab: 'active', customer: '' } },
  });
  // Another view is another default order, so the page it stood on means nothing there.
  const setView = (next: ListView) => {
    setViewPref(next);
    setPage(1);
  };
  const tab: ProjectStatus | 'all' = (ORDER_TABS as readonly string[]).includes(extra.tab)
    ? (extra.tab as ProjectStatus | 'all')
    : 'active';
  const customerId = extra.customer && Number.isInteger(Number(extra.customer)) ? Number(extra.customer) : null;
  const { typed, setTyped, forget } = useSearchBox(q, setQ);
  const [perPage, setPerPage] = usePersistedState<number>(PER_PAGE_STORAGE_KEY, 24, parsePageSize);
  const [groupByCustomer, setGroupByCustomer] = useState<boolean>(() => {
    try {
      return localStorage.getItem(GROUP_STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [editing, setEditing] = useState<OrderListItem | null | 'new'>(null);
  const [deleting, setDeleting] = useState<OrderListItem | null>(null);

  const params = {
    ...(tab !== 'all' ? { status: tab } : {}),
    ...(customerId != null ? { customer_id: customerId } : {}),
    ...(q ? { q } : {}),
    sort_by: sort,
    page,
    ...(perPage === -1 ? { all: true } : { per_page: perPage }),
  };
  const { data, isLoading, isPlaceholderData } = useQuery({
    queryKey: ['projects', params],
    queryFn: () => api.getOrdersPaged(params),
    // The old page stays on screen while the next one loads — no skeleton flash.
    placeholderData: keepPreviousData,
  });
  const { data: customers = [] } = useQuery({ queryKey: ['customers'], queryFn: api.getCustomers });
  // A delete (ours or someone else's) can leave us past the last page. Only an
  // answer for THIS view may clamp: the previous page's, still on screen while
  // the next loads, knows nothing about how many pages the new filter has.
  useEffect(() => {
    if (data && !isPlaceholderData) clampToLastPage(data.meta.last_page);
  }, [data, isPlaceholderData, clampToLastPage]);

  const total = data?.meta.total ?? 0;
  const filtered = q !== '' || customerId != null;

  // The farm-wide filament strip over the list — every active order, not just the visible tab/filter.
  const filamentQuery = useQuery({ queryKey: ['orders-filament'], queryFn: api.getOrdersFilament, staleTime: 30_000 });

  // `CustomerListFigures` and `CustomerFigures` are computed from these very
  // orders, so every status change moves a customer tile — and this page
  // does not know whose order it just touched, which is why every key in the
  // set is a prefix. See `utils/queryInvalidation.ts`.
  const invalidate = () => invalidateOrderViews(queryClient);

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: ProjectStatus }) => api.updateOrder(id, { status }),
    onSuccess: invalidate,
    onError: (e: Error) => showToast(e.message, 'error'),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.deleteOrder(id),
    // ⚠️ The id is passed because this is a LIST: the deleted order's own
    // `['project', id]` entry has no observer here, so nothing would ever
    // clear it and the next visit to a reused id — or a Back into the route
    // that just went — would render it out of cache inside the 60 s
    // `staleTime`. The order PAGE passes no id; it uses `useForgetOnUnmount`
    // instead, for the reason spelled out in `utils/queryInvalidation`.
    onSuccess: (_res, id) => {
      invalidateAfterDelete(queryClient, 'order', id);
      showToast(t('orders.toast.deleted'));
      setDeleting(null);
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });
  const duplicate = useMutation({
    mutationFn: (id: number) => api.duplicateOrder(id),
    onSuccess: (saved) => {
      invalidate();
      showToast(t('orders.toast.duplicated'));
      navigate(`/projects/${saved.id}`);
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  const toggleGroupByCustomer = (value: boolean) => {
    setGroupByCustomer(value);
    try {
      localStorage.setItem(GROUP_STORAGE_KEY, value ? '1' : '0');
    } catch {
      // Private browsing / storage disabled — the toggle still works this session.
    }
  };

  return (
    <div className="p-4">
      <ProjectsTabs />

      <ListPageHeader title={t('orders.list.title')} subtitle={t('orders.list.subtitle')}>
        <ListViewToggle value={view} options={views} onChange={setView} />
        {hasPermission('projects:create') && (
          <Button onClick={() => setEditing('new')}>
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
        <OrderStatusTabs tab={tab} totals={data?.totals} onChange={(key) => setExtra('tab', key)} />

        <ListSearchBox value={typed} onChange={setTyped} placeholder={t('orders.list.searchPlaceholder')} />

        <Select value={customerId ?? ''} onChange={(e) => setExtra('customer', e.target.value)}>
          <option value="">{t('orders.list.customerFilterAll')}</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>

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

        {/* A table sorts from its headers; the cards need a control of their own. */}
        {view === 'cards' && <ListSortControl sort={sort} options={sortOptions} onChange={setSort} />}
      </div>

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
        onEdit={setEditing}
        onDuplicate={(o) => duplicate.mutate(o.id)}
        onSetStatus={(o, status) => setStatus.mutate({ id: o.id, status })}
        onDelete={setDeleting}
      />

      {editing && (
        <OrderModal order={editing === 'new' ? null : editing} defaultCustomerId={customerId} onClose={() => setEditing(null)} />
      )}

      {deleting && (
        <ConfirmModal
          title={t('orders.confirm.deleteTitle')}
          message={t('orders.confirm.deleteBody')}
          variant="danger"
          isLoading={remove.isPending}
          onConfirm={() => remove.mutate(deleting.id)}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
