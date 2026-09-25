import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { api } from '../../api/client';
import type { OrderListItem, ProjectStatus } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { ProgressBar } from '../../components/projects/ProgressBar';
import { OrderStatusTabs, OrdersListView } from '../../components/projects/OrdersListView';
import { ORDER_TABS, ORDERS_DEFAULT_SORT } from '../../components/projects/orderList';
import { useOrderSortOptions } from '../../hooks/useOrderSortOptions';
import { OrderModal } from '../../components/projects/OrderModal';
import { CustomerModal } from '../../components/customers/CustomerModal';
import { ConfirmModal } from '../../components/ConfirmModal';
import { Button } from '../../components/Button';
import { ListSortControl } from '../../components/ListSortControl';
import { ListViewToggle } from '../../components/ListViewToggle';
import type { ListView } from '../../components/ListViewToggle';
import { StatTile, StatTiles } from '../../components/StatTile';
import { formatMoney } from '../../utils/currency';
import { invalidateAfterDelete, invalidateOrderViews } from '../../utils/queryInvalidation';
import { useCardsTableViews } from '../../hooks/useCardsTableViews';
import { useForgetOnUnmount } from '../../hooks/useForgetOnUnmount';
import { useListUrlState } from '../../hooks/useListUrlState';
import { parseListView, parsePageSize, usePersistedState } from '../../hooks/usePersistedState';

/**
 * One customer: its figures (three tiles) and one server page of its orders —
 * tab counts are the server's `totals`, never the rows on screen (spec
 * workshop-lists, rules 16–17).
 *
 * The detail endpoint's `figures` is a superset of the list one — only it
 * carries `ordered`/`printed`/`covered_units`/`total_cost`. The
 * `'ordered' in figures` guard is what keeps a list row (which has none of
 * them) from silently rendering an empty progress bar if this component is
 * ever handed one. The orders block is the orders page's own `OrdersListView`
 * with the customer fixed; its tab, sort and page live in the URL.
 */
export function CustomerPage() {
  const { t } = useTranslation();
  const { id: idParam } = useParams<{ id: string }>();
  const id = Number(idParam);
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const forgetCustomer = useForgetOnUnmount(['customer', id]);

  const [view, setViewPref] = usePersistedState<ListView>('bamdude-customer-orders-view', 'cards', parseListView);
  const views = useCardsTableViews();
  const sortOptions = useOrderSortOptions();
  const { page, sort, extra, setPage, setSort, setExtra, clampToLastPage } = useListUrlState({
    defaults: { sort: ORDERS_DEFAULT_SORT[view], extra: { tab: 'active' } },
  });
  // Another view is another default order, so the page it stood on means nothing there.
  const setView = (next: ListView) => {
    setViewPref(next);
    setPage(1);
  };
  const [perPage, setPerPage] = usePersistedState<number>('bamdude-customer-orders-perPage', 24, parsePageSize);
  const tab: ProjectStatus | 'all' = (ORDER_TABS as readonly string[]).includes(extra.tab)
    ? (extra.tab as ProjectStatus | 'all')
    : 'active';
  const [editingCustomer, setEditingCustomer] = useState(false);
  const [deletingCustomer, setDeletingCustomer] = useState(false);
  const [editingOrder, setEditingOrder] = useState<OrderListItem | null | 'new'>(null);
  const [deletingOrder, setDeletingOrder] = useState<OrderListItem | null>(null);

  const {
    data: customer,
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: ['customer', id],
    queryFn: () => api.getCustomer(id),
    enabled: Number.isFinite(id),
    // This page keeps its data when a REFETCH fails (see the note below), so
    // it is the cache's job to say the figures are older than they look.
    meta: { refreshToast: true },
  });
  const orderParams = {
    customer_id: id,
    ...(tab !== 'all' ? { status: tab } : {}),
    sort_by: sort,
    page,
    ...(perPage === -1 ? { all: true } : { per_page: perPage }),
  };
  const ordersQuery = useQuery({
    queryKey: ['projects', orderParams],
    queryFn: () => api.getOrdersPaged(orderParams),
    enabled: Number.isFinite(id),
    // The previous page stays on screen while the next one loads — but only
    // THIS customer's: another customer's orders, even dimmed, would be a lie.
    placeholderData: (previous, previousQuery) =>
      (previousQuery?.queryKey[1] as { customer_id?: number } | undefined)?.customer_id === id ? previous : undefined,
  });
  // A delete can leave us past the last page. Only an answer for THIS view may
  // clamp — the previous page's knows nothing about the new filter.
  useEffect(() => {
    if (ordersQuery.data && !ordersQuery.isPlaceholderData) clampToLastPage(ordersQuery.data.meta.last_page);
  }, [ordersQuery.data, ordersQuery.isPlaceholderData, clampToLastPage]);
  // The app-wide currency, fetched the way every other money-showing screen
  // fetches it; `formatMoney` covers the unresolved first paint.
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings, staleTime: 60_000 });

  const removeCustomer = useMutation({
    mutationFn: () => api.deleteCustomer(id),
    // ⚠️ The LISTS only. The orders survive without a customer, so their
    // rows are stale — but `['customer', id]` is the row that just went, and
    // refetching it while this page is still mounted lands a 404 on the way out.
    onSuccess: () => {
      invalidateAfterDelete(queryClient, 'customer');
      showToast(t('customers.toast.deleted'));
      // ⚠️ The entry goes when this page UNMOUNTS, not on the next line: a
      // `removeQueries` here would run while the page is still mounted (React
      // has only scheduled the route change) and its own observer would refetch
      // the customer that was just deleted. Armed here, dropped on unmount —
      // see `useForgetOnUnmount`. Without it a Back inside the 60 s
      // `staleTime` renders the deleted customer out of cache.
      forgetCustomer();
      navigate('/customers');
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  const setOrderStatus = useMutation({
    mutationFn: ({ orderId, status }: { orderId: number; status: ProjectStatus }) =>
      api.updateOrder(orderId, { status }),
    onSuccess: () => invalidateOrderViews(queryClient, { customerId: id }),
    onError: (e: Error) => showToast(e.message, 'error'),
  });
  const removeOrder = useMutation({
    mutationFn: (orderId: number) => api.deleteOrder(orderId),
    // The order LIST on this page — so the id goes, and the deleted order's own
    // entry leaves the cache with it. (The customer delete above passes none:
    // that row's page is this one, and it unmounts.)
    onSuccess: (_res, orderId) => {
      invalidateAfterDelete(queryClient, 'order', orderId);
      showToast(t('orders.toast.deleted'));
      setDeletingOrder(null);
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });
  const duplicateOrder = useMutation({
    mutationFn: (orderId: number) => api.duplicateOrder(orderId),
    onSuccess: (saved) => {
      invalidateOrderViews(queryClient, { orderId: saved.id, customerId: id });
      showToast(t('orders.toast.duplicated'));
      navigate(`/projects/${saved.id}`);
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  if (isLoading) {
    return (
      <div className="p-4 flex items-center gap-2 text-bambu-gray">
        <Loader2 className="w-4 h-4 animate-spin" />
        {t('common.loading')}
      </div>
    );
  }
  // ⚠️ Data presence first, then `isError` — see the long note on ProductPage.
  // A failed background refetch (this page invalidates `['customer', id]` on
  // every order it creates, edits or deletes) must not replace a customer the
  // cache still holds; and with no data, a failed fetch is not a customer
  // somebody removed.
  if (!customer) {
    return isError ? (
      <div className="p-4 text-sm text-red-500">
        {t('customers.page.loadFailed')} {(error as Error)?.message}
      </div>
    ) : (
      <div className="p-4 text-bambu-gray text-sm">{t('customers.page.notFound')}</div>
    );
  }

  const figures = customer.figures;
  const detailed = 'ordered' in figures ? figures : null;
  const ordersTotal = ordersQuery.data?.meta.total ?? 0;

  return (
    <div className="p-4 space-y-4">
      <nav className="flex items-center gap-1 text-sm text-bambu-gray">
        <Link to="/customers" className="hover:text-white transition-colors">
          {t('projects.tabs.customers')}
        </Link>
        <ChevronRight className="w-4 h-4" />
        <span className="text-white">{customer.name}</span>
      </nav>

      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0 space-y-1">
          <h1 className="text-2xl font-semibold text-white">{customer.name}</h1>
          {customer.contact && <p className="text-sm text-bambu-gray">{customer.contact}</p>}
          {customer.notes && <p className="text-sm text-bambu-gray whitespace-pre-line">{customer.notes}</p>}
        </div>
        <div className="flex items-center gap-2">
          {hasPermission('projects:update') && (
            <Button variant="secondary" onClick={() => setEditingCustomer(true)}>
              <Pencil className="w-4 h-4" />
              {t('common.edit')}
            </Button>
          )}
          {hasPermission('projects:delete') && (
            <Button variant="secondary" onClick={() => setDeletingCustomer(true)}>
              <Trash2 className="w-4 h-4" />
              {t('common.delete')}
            </Button>
          )}
        </div>
      </header>

      <StatTiles columns={3}>
        <StatTile
          testId="customer-tile-orders"
          label={t('customers.page.tiles.orders')}
          value={figures.projects}
          sub={t('customers.page.tiles.ordersSub', {
            active: figures.active,
            completed: figures.completed,
            cancelled: figures.cancelled,
          })}
        />
        <StatTile
          testId="customer-tile-money"
          label={t('customers.page.tiles.money')}
          value={formatMoney(figures.total_price, settings?.currency)}
          sub={
            detailed
              ? t('customers.page.tiles.moneySub', { cost: formatMoney(detailed.total_cost, settings?.currency) })
              : undefined
          }
        />
        <StatTile
          testId="customer-tile-covered"
          label={t('customers.page.tiles.covered')}
          sub={
            detailed
              ? detailed.ordered > 0
                ? t('customers.page.tiles.coveredSub', { printed: detailed.printed })
                : t('customers.page.tiles.nothingOrdered')
              : undefined
          }
        >
          {detailed && <ProgressBar value={detailed.covered_units} max={detailed.ordered} testId="customer-covered" />}
        </StatTile>
      </StatTiles>

      <section className="space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h2 className="text-lg font-medium text-white">{t('customers.page.orders')}</h2>
          <div className="flex items-center gap-2 flex-wrap">
            <ListViewToggle value={view} options={views} onChange={setView} />
            {hasPermission('projects:create') && (
              <Button onClick={() => setEditingOrder('new')}>
                <Plus className="w-4 h-4" />
                {t('customers.page.newOrder')}
              </Button>
            )}
          </div>
        </div>

        <div className="flex items-center gap-4 flex-wrap">
          <OrderStatusTabs tab={tab} totals={ordersQuery.data?.totals} onChange={(key) => setExtra('tab', key)} />
          {/* A table sorts from its headers; the cards need a control of their own. */}
          {view === 'cards' && <ListSortControl sort={sort} options={sortOptions} onChange={setSort} />}
        </div>

        {!ordersQuery.isLoading && ordersTotal === 0 ? (
          <p className="text-bambu-gray text-sm">{t(`orders.list.empty.${tab}`)}</p>
        ) : (
          <OrdersListView
            data={ordersQuery.data}
            isLoading={ordersQuery.isLoading}
            isPlaceholderData={ordersQuery.isPlaceholderData}
            view={view}
            sort={sort}
            onSortChange={setSort}
            perPage={perPage}
            onPageChange={setPage}
            onPerPageChange={(n) => {
              setPerPage(n);
              setPage(1);
            }}
            onEdit={setEditingOrder}
            onDuplicate={(o) => duplicateOrder.mutate(o.id)}
            onSetStatus={(o, status) => setOrderStatus.mutate({ orderId: o.id, status })}
            onDelete={setDeletingOrder}
          />
        )}
      </section>

      {editingCustomer && <CustomerModal customer={customer} onClose={() => setEditingCustomer(false)} />}

      {editingOrder && (
        <OrderModal
          order={editingOrder === 'new' ? null : editingOrder}
          defaultCustomerId={id}
          onClose={() => setEditingOrder(null)}
        />
      )}

      {deletingCustomer && (
        <ConfirmModal
          title={t('customers.confirm.deleteTitle')}
          message={t('customers.confirm.deleteBody')}
          variant="danger"
          isLoading={removeCustomer.isPending}
          onConfirm={() => removeCustomer.mutate()}
          onCancel={() => setDeletingCustomer(false)}
        />
      )}

      {deletingOrder && (
        <ConfirmModal
          title={t('orders.confirm.deleteTitle')}
          message={t('orders.confirm.deleteBody')}
          variant="danger"
          isLoading={removeOrder.isPending}
          onConfirm={() => removeOrder.mutate(deletingOrder.id)}
          onCancel={() => setDeletingOrder(null)}
        />
      )}
    </div>
  );
}
