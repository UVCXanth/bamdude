import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '../../api/client';
import type { Order } from '../../api/client';
import { useOrderDetail } from '../../hooks/useOrderDetail';
import { useSearchBox } from '../../hooks/useSearchBox';
import { Select } from '../Select';
import { LoadFailedNote } from '../workshop/LoadFailedNote';

const ORDER_PAGE = 20;

/** An order as a choice reports it — what a caller needs to name it. */
export interface ChosenOrder {
  id: number;
  code: string;
  name: string;
}

type Row = Pick<Order, 'id' | 'code' | 'name' | 'customer_name'>;

/**
 * Which order (WS-13 E13 D01 / D01a) — one picker for the add-to-order dialog, the
 * archive editor and the bulk «Order» on the archives page.
 *
 * - **Policy (D01):** a server search over ACTIVE orders only — a closed order is
 *   never offered for new work. The CURRENT order is another matter: whatever its
 *   status, it stays visible and chosen, named with its status when it is not
 *   active, so saving another field never clears it.
 * - **Session (D01a):** the value is an id with a label of its own — from the row it
 *   was picked from, else read separately (`useOrderDetail`, the one definition of
 *   that query) — so a choice beyond the first page or hidden by a search still
 *   shows. Real paging; a new search starts at page 1; the choice lives outside the
 *   page and the search. A page that fails says so with a retry and loses nothing,
 *   and a late answer to an earlier search never replaces the current one (each
 *   search and page is its own query key).
 */
export function OrderChoice({
  value,
  onChange,
  allowNone = false,
  disabled = false,
  id,
  label,
  stacked = false,
}: {
  value: number | null;
  onChange: (order: ChosenOrder | null) => void;
  /** «No order» as a choice of its own (the archive editor); otherwise the empty entry only asks. */
  allowNone?: boolean;
  /** Read-only: the current order is shown, nothing is searched. */
  disabled?: boolean;
  /** The select's id, for a caller that labels it with its own `<label htmlFor>`. */
  id?: string;
  /** A label drawn in the row itself (the add dialog's «To order»). */
  label?: string;
  /** Search above the list, each full width — the form dialogs' layout. */
  stacked?: boolean;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const setQuery = useCallback((next: string) => {
    setQ(next);
    setPage(1);
  }, []);
  const { typed, setTyped } = useSearchBox(q, setQuery);
  const params = { status: 'active' as const, ...(q ? { q } : {}), page, per_page: ORDER_PAGE };
  const list = useQuery({
    queryKey: ['orders', 'order-choice', params],
    queryFn: () => api.getOrdersPaged(params),
    enabled: !disabled,
  });
  // The page count the last answer gave — kept while another page loads or fails,
  // so the way back is still there.
  const [pages, setPages] = useState(1);
  const lastPage = list.data?.meta.last_page;
  useEffect(() => {
    if (lastPage != null) setPages(lastPage);
  }, [lastPage]);

  const rowLabel = (o: Row) => `${o.code} · ${o.name} · ${o.customer_name ?? t('orders.add.noCustomer')}`;
  const orders = list.data?.items ?? [];
  const onPage = value != null ? orders.find((o) => o.id === value) : undefined;
  // Labels of orders seen as rows in this session, for when a later page or search
  // no longer lists them.
  const [seen, setSeen] = useState<Map<number, string>>(() => new Map());
  const onPageLabel = onPage ? rowLabel(onPage) : undefined;
  useEffect(() => {
    if (value == null || onPageLabel == null) return;
    setSeen((prev) => (prev.get(value) === onPageLabel ? prev : new Map(prev).set(value, onPageLabel)));
  }, [value, onPageLabel]);
  const remembered = value != null ? seen.get(value) : undefined;
  // An order bound before the picker opened, beyond the first page or closed: read on
  // its own, only for its label.
  const detail = useOrderDetail(value != null && onPage == null && remembered == null ? value : null);
  const bound = detail.data?.id === value ? detail.data : undefined;
  const chosenLabel =
    onPageLabel ??
    remembered ??
    (bound
      ? `${bound.code} · ${bound.name}${bound.status !== 'active' ? ` · ${t(`orders.status.${bound.status}`)}` : ''}`
      : t('pickers.orderUnread'));

  const status = disabled ? null : list.isPending ? (
    <span className="text-sm text-bambu-gray">{t('orders.add.orderLoading')}</span>
  ) : list.isError ? (
    <LoadFailedNote message={t('orders.add.orderFailed')} onRetry={() => list.refetch()} />
  ) : orders.length === 0 ? (
    <span className="text-sm text-bambu-gray">{q ? t('orders.add.noOrdersFound') : t('orders.add.noActiveOrders')}</span>
  ) : null;
  const pager =
    !disabled && pages > 1 ? (
      <span className="flex items-center gap-1 text-sm text-bambu-gray">
        <button
          type="button"
          aria-label={t('common.previous')}
          disabled={page <= 1}
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          className="p-1 rounded hover:bg-bambu-dark-tertiary disabled:opacity-40"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <span>{t('common.pageOf', { page, total: pages })}</span>
        <button
          type="button"
          aria-label={t('common.next')}
          disabled={page >= pages}
          onClick={() => setPage((p) => Math.min(pages, p + 1))}
          className="p-1 rounded hover:bg-bambu-dark-tertiary disabled:opacity-40"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </span>
    ) : null;

  return (
    <div className={stacked ? 'space-y-2' : 'flex flex-wrap items-center gap-x-3 gap-y-2'}>
      {label && <span className="text-sm text-bambu-gray">{label}</span>}
      <input
        type="search"
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        disabled={disabled}
        placeholder={t('orders.add.findOrder')}
        aria-label={t('orders.add.findOrder')}
        className={`${stacked ? 'w-full ' : ''}min-h-[44px] rounded-lg border border-bambu-dark-tertiary bg-bambu-dark px-3 py-2 text-sm text-white focus:border-bambu-green focus:outline-none disabled:opacity-60 md:min-h-0`}
      />
      <Select
        id={id}
        aria-label={id ? undefined : t('orders.add.order')}
        value={value == null ? '' : String(value)}
        disabled={disabled || list.isPending}
        onChange={(e) => {
          const next = e.target.value ? Number(e.target.value) : null;
          if (next == null) {
            onChange(null);
            return;
          }
          const found = orders.find((o) => o.id === next);
          if (found) onChange({ id: found.id, code: found.code, name: found.name });
        }}
        className={stacked ? 'w-full' : 'min-w-64'}
      >
        <option value="">{allowNone ? t('pickers.noOrder') : t('orders.add.chooseOrder')}</option>
        {/* The current order, wherever the results are — chosen here or bound already. */}
        {value != null && onPage == null && <option value={String(value)}>{chosenLabel}</option>}
        {orders.map((o) => (
          <option key={o.id} value={String(o.id)}>
            {rowLabel(o)}
          </option>
        ))}
      </Select>
      {(status || pager) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {status}
          {pager}
        </div>
      )}
    </div>
  );
}
