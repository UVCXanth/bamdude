import { useEffect, useId, useRef, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Plus, X } from 'lucide-react';
import { api } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { CustomersTable } from '../../components/customers/CustomersTable';
import { CustomerCard } from '../../components/customers/CustomerCard';
import { CustomerModal } from '../../components/customers/CustomerModal';
import { CustomersSkeleton } from '../../components/customers/CustomersSkeleton';
import { CustomersTiles } from '../../components/customers/CustomersTiles';
import { useCustomerActions } from '../../components/customers/useCustomerActions';
import { Button } from '../../components/Button';
import { ListPageHeader } from '../../components/ListPageHeader';
import { ListSearchBox } from '../../components/ListSearchBox';
import { ListViewToggle } from '../../components/ListViewToggle';
import { ListSortControl } from '../../components/ListSortControl';
import type { ListView } from '../../components/ListViewToggle';
import { PaginationBar } from '../../components/PaginationBar';
import { LoadFailedNote } from '../../components/workshop/LoadFailedNote';
import { RefreshFailedNote } from '../../components/workshop/RefreshFailedNote';
import { WorkshopPanel } from '../../components/workshop/WorkshopPanel';
import { WorkshopTabPanel, WorkshopTabs } from '../../components/workshop/WorkshopTabs';
import { useCardsTableViews } from '../../hooks/useCardsTableViews';
import { useListUrlState } from '../../hooks/useListUrlState';
import { parseListView, parsePageSize, usePersistedState } from '../../hooks/usePersistedState';
import { useSearchBox } from '../../hooks/useSearchBox';
import { answeredEmpty, listState } from '../../utils/listState';

const SHOW = ['all', 'active', 'regular'] as const;
type Show = (typeof SHOW)[number];
/** The keys a table header sorts by (B06); the others are named above the table. */
const HEADER_SORT = new Set(['name', 'orders', 'total_price']);

/**
 * Who the orders are for (WS-13 E11 B). Customers have no status of their own: the list is
 * a search (name, code or any contact field) and three underline tabs — all, with active
 * orders, regular — one page at a time from the server (specs projects-lists-parity,
 * workshop-customers). Search, tab, sort and page live in the URL; the view mode (table by
 * default) and the page size are preferences. What the list's read said is `listState`: a
 * skeleton, a failed key as an alert with its retry, a failed re-read beside its rows —
 * never «no customers» for a list that could not be read.
 */
export function CustomersPage() {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const heading = useRef<HTMLHeadingElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const tabsId = useId();

  const { page, q, sort, extra, setPage, setQ, setSort, setExtra, resetFilters, clampToLastPage } = useListUrlState({
    defaults: { sort: 'name-asc', extra: { show: 'all' } },
  });
  // An unknown `?show=` is «All»; the address is left as it is (B03).
  const show: Show = (SHOW as readonly string[]).includes(extra.show) ? (extra.show as Show) : 'all';
  const { typed, setTyped, forget } = useSearchBox(q, setQ);
  const [view, setView] = usePersistedState<ListView>('bamdude-customers-view', 'table', parseListView);
  const views = useCardsTableViews();
  const [perPage, setPerPage] = usePersistedState<number>('bamdude-customers-perPage', 24, parsePageSize);
  const [creating, setCreating] = useState(false);
  const actions = useCustomerActions({ context: 'list', fallbackFocusRef: heading });

  const params = {
    ...(q ? { q } : {}),
    ...(show === 'active' ? { with_active: true } : {}),
    ...(show === 'regular' ? { kind: 'regular' as const } : {}),
    sort_by: sort,
    page,
    ...(perPage === -1 ? { all: true } : { per_page: perPage }),
  };
  const { data, isError, isPlaceholderData, refetch } = useQuery({
    queryKey: ['customers', params],
    queryFn: () => api.getCustomersPaged(params),
    placeholderData: keepPreviousData,
  });
  const customers = data?.items ?? [];
  const total = data?.meta.total ?? 0;
  const state = listState({ data, isError, isPlaceholderData });
  // The empty explanation stays under a failed re-read of an empty answer (E7-V01).
  const emptyAnswer = answeredEmpty(state, data);
  // A delete (ours or someone else's) can leave us past the last page. Only an
  // answer for THIS view may clamp: the previous page's, still on screen while
  // the next loads, knows nothing about how many pages the new filter has.
  useEffect(() => {
    if (data && !isPlaceholderData) clampToLastPage(data.meta.last_page);
  }, [data, isPlaceholderData, clampToLastPage]);

  const narrowed = q !== '' || show !== 'all';
  const resetConditions = () => {
    forget();
    resetFilters();
    searchRef.current?.focus();
  };

  const sortOptions = [
    { key: 'name', label: t('customers.table.name') },
    { key: 'created', label: t('list.sort.created'), descFirst: true },
    { key: 'orders', label: t('customers.table.orders'), descFirst: true },
    { key: 'active', label: t('customers.table.active'), descFirst: true },
    { key: 'completed', label: t('customers.table.completed'), descFirst: true },
    { key: 'cancelled', label: t('customers.table.cancelled'), descFirst: true },
    { key: 'total_price', label: t('customers.table.totalPrice'), descFirst: true },
  ];
  const [sortKey, sortDir] = sort.split('-');
  // A key the table has no header for is still the server's sort: named above the table,
  // with a way to take it off (B06, as E8-D03). An unknown key is the server's default.
  const headerless =
    view === 'table' && !HEADER_SORT.has(sortKey) ? sortOptions.find((o) => o.key === sortKey) : undefined;

  const pageBar = (variant: 'card' | 'bare') =>
    data ? (
      <PaginationBar
        page={data.meta.current_page}
        totalPages={data.meta.last_page}
        perPage={perPage}
        total={total}
        onPageChange={setPage}
        onPerPageChange={(n) => {
          setPerPage(n);
          setPage(1);
        }}
        items={t('customers.list.items', { count: total })}
        variant={variant}
      />
    ) : null;
  // The currency, the way every money-showing screen reads it (the table asks too).
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings, staleTime: 60_000 });

  return (
    <div className="workshop p-4">
      <ListPageHeader title={t('customers.list.title')} subtitle={t('customers.list.subtitle')} headingRef={heading}>
        <ListViewToggle value={view} options={views} onChange={setView} />
        {hasPermission('projects:create') && (
          <Button onClick={() => setCreating(true)}>
            <Plus className="w-4 h-4" />
            {t('customers.list.newCustomer')}
          </Button>
        )}
      </ListPageHeader>

      <CustomersTiles />

      <div className="flex items-center gap-4 mb-4 flex-wrap">
        <WorkshopTabs
          idBase={tabsId}
          ariaLabel={t('customers.list.filter.label')}
          value={show}
          items={SHOW.map((key) => ({ value: key, label: t(`customers.list.filter.${key}`) }))}
          onChange={(key) => setExtra('show', key)}
        />
        <ListSearchBox
          value={typed}
          onChange={setTyped}
          placeholder={t('customers.list.searchPlaceholder')}
          inputRef={searchRef}
        />
        <div className="ml-auto flex items-center gap-3">
          {headerless && (
            <span
              data-testid="customers-sort-chip"
              className="inline-flex items-center gap-1 px-2 py-1 rounded bg-bambu-dark-tertiary text-xs text-white"
            >
              {t('customers.list.sortChip', { label: headerless.label, dir: sortDir === 'desc' ? '↓' : '↑' })}
              <button type="button" aria-label={t('customers.list.sortChipRemove')} onClick={() => setSort('name-asc')}>
                <X className="w-3 h-3" />
              </button>
            </span>
          )}
          {/* A table sorts from its headers; the cards need a control of their own. */}
          {view === 'cards' && <ListSortControl sort={sort} options={sortOptions} onChange={setSort} />}
        </div>
      </div>

      <WorkshopTabPanel idBase={tabsId} value={show}>
        {state === 'loading' && <CustomersSkeleton view={view} />}
        {state === 'failed' && <LoadFailedNote message={t('customers.list.loadFailed')} onRetry={() => refetch()} />}
        {state === 'refresh-failed' && <RefreshFailedNote onRetry={() => refetch()} />}

        {emptyAnswer &&
          (narrowed ? (
            <WorkshopPanel>
              <div className="px-4 py-10 text-center text-sm text-bambu-gray">
                <p className="mb-2 text-base font-semibold text-white">{t('customers.list.noMatchTitle')}</p>
                <Button variant="ghost" onClick={resetConditions}>
                  {t('customers.list.resetFilters')}
                </Button>
              </div>
            </WorkshopPanel>
          ) : (
            <p className="text-bambu-gray text-sm">{t('customers.list.empty')}</p>
          ))}

        {/* The previous page stays on screen while the next one loads — dimmed
            and marked busy, so it is not read as the answer to the new question. */}
        {data && !emptyAnswer && (
          <div
            data-testid="list-body"
            aria-busy={isPlaceholderData}
            className={`transition-opacity ${isPlaceholderData ? 'opacity-60' : ''}`}
          >
            {view === 'cards' ? (
              <>
                <div className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(min(260px,100%),1fr))]">
                  {customers.map((customer) => (
                    <CustomerCard key={customer.id} customer={customer} currency={settings?.currency} actions={actions} />
                  ))}
                </div>
                {total > 0 && <div className="mt-4">{pageBar('bare')}</div>}
              </>
            ) : (
              <CustomersTable
                customers={customers}
                actions={actions}
                sort={sort}
                onSortChange={setSort}
                footer={pageBar('card')}
              />
            )}
          </div>
        )}
      </WorkshopTabPanel>

      {creating && <CustomerModal customer={null} onClose={() => setCreating(false)} />}
      {actions.host}
    </div>
  );
}
