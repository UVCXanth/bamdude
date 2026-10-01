import { useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { OrderListItem, OrderListPage } from '../../api/client';
import { useIsWideLayout } from '../../hooks/useIsWideLayout';
import { isOverdue } from '../../utils/orderDates';
import { PaginationBar } from '../PaginationBar';
import { OrderView } from './OrderView';
import type { OrderActions } from './orderActions/useOrderActions';
import { parseOrderSection, type OrderSection } from './orderSections';
import { ProgressBar } from './ProgressBar';
import { StageBadge } from './StageBadge';

interface OrdersWorkspaceProps {
  data: OrderListPage | undefined;
  isLoading: boolean;
  isPlaceholderData: boolean;
  perPage: number;
  onPageChange: (page: number) => void;
  onPerPageChange: (perPage: number) => void;
  /** The order named in the URL, if any. */
  picked: number | null;
  onPick: (id: number | null) => void;
  /** The URL's `section` — it belongs to the order the URL names (`picked`), no other. */
  section?: string;
  /** A tab chosen on the shown order: the owner writes that order AND the tab, in one go. */
  onSection?: (orderId: number, section: OrderSection) => void;
  /** The PAGE's order action host (WS-13 E6 B01): the pane is keyed by order, the host is not. */
  actions: OrderActions;
}

/**
 * The workspace (spec workshop-order-views, rules 10–13): the SAME server page
 * as the table on the left, compact, and the picked order on the right. The
 * pick lives in the URL; without one — or when it is not on this page — the
 * first row is shown. Below `lg` there is no room for two columns: the list
 * alone, and a row opens the order page.
 */
export function OrdersWorkspace({
  data,
  isLoading,
  isPlaceholderData,
  perPage,
  onPageChange,
  onPerPageChange,
  picked,
  onPick,
  section,
  onSection,
  actions,
}: OrdersWorkspaceProps) {
  const { t } = useTranslation();
  const wide = useIsWideLayout();
  // An order deleted from the right pane stays in the page until the list is
  // read again; the pane must not fall back onto it meanwhile. The skip is tied
  // to the answer it was made against and ends with the next one — on SQLite a
  // new order can take the deleted id, and must not be hidden with it.
  const [gone, setGone] = useState<{ id: number; page: OrderListPage | undefined } | null>(null);
  const skip = gone && gone.page === data ? gone.id : null;
  const items = (data?.items ?? []).filter((o) => o.id !== skip);
  const shown = picked != null && items.some((o) => o.id === picked) ? picked : (items[0]?.id ?? null);
  // The tab shown is DERIVED, never reset by an effect (WS-13 E3 F03, R01): the
  // URL's section is the tab of the order the URL names; any other order on the
  // right — another page, a filter, a refetch, a deleted row, the first-row
  // fallback — opens on the plan. A placeholder page shows the previous rows, so
  // `shown` and the tab hold until the new answer.
  const shownSection: OrderSection = picked != null && picked === shown ? parseOrderSection(section) : 'plan';
  const total = data?.meta.total ?? 0;

  if (isLoading || !data || items.length === 0) return null;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(280px,22rem)_minmax(0,1fr)] items-start">
      <div
        data-testid="list-body"
        aria-busy={isPlaceholderData}
        className={`space-y-3 transition-opacity ${isPlaceholderData ? 'opacity-60' : ''}`}
      >
        <ul aria-label={t('orders.list.title')} className="space-y-1.5">
          {items.map((order) => (
            <li key={order.id}>
              {wide ? (
                <button
                  type="button"
                  aria-current={order.id === shown ? 'true' : undefined}
                  // Picking the order the URL already names writes nothing — its tab stays
                  // (F03); a row shown only as the fallback is pinned by the click (review 3).
                  onClick={() => {
                    if (order.id !== picked) onPick(order.id);
                  }}
                  className={rowClass(order.id === shown)}
                >
                  <WorkspaceRow order={order} />
                </button>
              ) : (
                <Link to={`/projects/${order.id}`} className={rowClass(false)}>
                  <WorkspaceRow order={order} />
                </Link>
              )}
            </li>
          ))}
        </ul>
        <PaginationBar
          page={data.meta.current_page}
          totalPages={data.meta.last_page}
          perPage={perPage}
          total={total}
          onPageChange={onPageChange}
          onPerPageChange={onPerPageChange}
          items={t('orders.list.items', { count: total })}
          variant="bare"
        />
      </div>

      {wide && shown != null && (
        // No frame of its own (WS-13 E3 H03): the order view brings its panels, and a
        // frame around them would be the third nested one.
        <div className="min-w-0">
          {/* Keyed by id: another order is another view — its dialogs, its draft, and the
              forget-on-unmount of a deleted one all belong to the order they were opened for. */}
          <OrderView
            key={shown}
            id={shown}
            embedded
            actions={actions}
            section={shownSection}
            onSectionChange={(next) => onSection?.(shown, next)}
            onDeleted={() => {
              setGone({ id: shown, page: data });
              onPick(null);
            }}
          />
        </div>
      )}
    </div>
  );
}

function rowClass(current: boolean) {
  return `block w-full text-left rounded-lg border px-3 py-2 space-y-1 ${
    current ? 'border-bambu-green bg-bambu-dark-tertiary' : 'border-bambu-dark-tertiary bg-bambu-dark-secondary hover:border-bambu-green/50'
  }`;
}

/** code · deadline, the stage, the name, the customer, the coverage — a table row folded into a column. */
function WorkspaceRow({ order }: { order: OrderListItem }) {
  const overdue = isOverdue(order);
  return (
    <>
      <span className="flex items-center justify-between gap-2 text-xs text-bambu-gray">
        <span>
          {order.code}
          {order.due_date && (
            <>
              {' · '}
              <span className={overdue ? 'text-red-500' : undefined}>{new Date(order.due_date).toLocaleDateString()}</span>
            </>
          )}
        </span>
        <StageBadge stage={order.stage} status={order.status} />
      </span>
      <span className="block text-sm font-medium text-white truncate">{order.name}</span>
      {order.customer_name && <span className="block text-xs text-bambu-gray truncate">{order.customer_name}</span>}
      <ProgressBar value={order.covered_units} max={order.ordered} progress={order.progress} testId={`workspace-${order.id}-progress`} />
    </>
  );
}
