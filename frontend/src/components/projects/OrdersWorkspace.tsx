import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { OrderListItem, OrderListPage } from '../../api/client';
import { PaginationBar } from '../PaginationBar';
import { LoadFailedNote } from '../workshop/LoadFailedNote';
import { RefreshFailedNote } from '../workshop/RefreshFailedNote';
import { OrderView } from './OrderView';
import type { OrderActions } from './orderActions/useOrderActions';
import { parseOrderSection, type OrderSection } from './orderSections';
import { StageBadge } from './StageBadge';
import { listState } from './orderRow/listState';
import { OrderCoverage } from './orderRow/OrderCoverage';
import { OrderDue } from './orderRow/OrderDue';

/**
 * Two columns from this viewport width up (WS-13 E7 G01) — the mockup's and the
 * spec's edge (≤ 760 stacks). ⚠️ The CSS classes below say `min-[761px]:` and this
 * constant must agree with them, or the layout half-applies.
 */
export const WORKSPACE_SPLIT_MIN = 761;

function useSplit(): boolean {
  const query = `(min-width: ${WORKSPACE_SPLIT_MIN}px)`;
  const [split, setSplit] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : true,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(query);
    const onChange = (event: MediaQueryListEvent) => setSplit(event.matches);
    setSplit(list.matches);
    list.addEventListener?.('change', onChange);
    return () => list.removeEventListener?.('change', onChange);
  }, [query]);
  return split;
}

interface OrdersWorkspaceProps {
  data: OrderListPage | undefined;
  /** The CURRENT key failed (WS-13 E7 G07): with no rows of its own an alert, with rows a note. */
  isError: boolean;
  onRetry: () => void;
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
 * The workspace (spec workshop-order-views, rules 10–13; WS-13 E7 G): the SAME
 * server page as the table on the left — one sticky panel of compact rows with
 * the page bar pinned to its bottom — and the shown order on the right. The pick
 * lives in the URL; without one — or when it is not on this page — the first row
 * is shown, and a pick the page does not hold is SAID (G05), never swapped
 * silently. At 760 px and narrower the list stands above the shown order.
 */
export function OrdersWorkspace({
  data,
  isError,
  onRetry,
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
  const split = useSplit();
  const [gone, setGone] = useState<{ id: number; page: OrderListPage | undefined } | null>(null);
  const skip = gone && gone.page === data ? gone.id : null;
  const items = (data?.items ?? []).filter((o) => o.id !== skip);
  const shown = picked != null && items.some((o) => o.id === picked) ? picked : (items[0]?.id ?? null);
  const shownSection: OrderSection = picked != null && picked === shown ? parseOrderSection(section) : 'plan';
  const total = data?.meta.total ?? 0;
  const state = listState({ data, isError, isPlaceholderData });
  // G05: the URL names an order this page does not hold — say so, never swap silently.
  // Not while the next page is on its way, and not after a delete (its own way out, E6-B08).
  const fallback =
    picked != null && picked !== skip && shown != null && picked !== shown && state !== 'transition'
      ? items.find((o) => o.id === shown)
      : undefined;

  // G06: on a narrow screen a pick scrolls to the order below the list (focus stays on the row).
  const paneRef = useRef<HTMLDivElement>(null);
  const lastPicked = useRef(picked);
  useEffect(() => {
    if (!split && picked != null && picked !== lastPicked.current) paneRef.current?.scrollIntoView?.({ block: 'start' });
    lastPicked.current = picked;
  }, [picked, split]);

  if (state === 'failed') return <LoadFailedNote message={t('orders.list.loadFailed')} onRetry={onRetry} />;
  if (!data || items.length === 0) return null;

  return (
    <div className="grid gap-4 items-start min-[761px]:grid-cols-[clamp(280px,20vw,400px)_minmax(0,1fr)]">
      <div
        data-testid="workspace-list"
        aria-busy={isPlaceholderData}
        className={`flex flex-col rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary overflow-y-auto transition-opacity ${
          isPlaceholderData ? 'opacity-60' : ''
        } max-[760px]:max-h-[50vh] min-[761px]:sticky min-[761px]:top-3 min-[761px]:max-h-[calc(100dvh-1.5rem)] min-[761px]:max-[1143px]:top-[68px] min-[761px]:max-[1143px]:max-h-[calc(100dvh-5rem)]`}
      >
        {state === 'refresh-failed' && (
          <div className="px-4 pt-2">
            <RefreshFailedNote onRetry={onRetry} />
          </div>
        )}
        <ul aria-label={t('orders.list.title')} className="flex-1">
          {items.map((order) => (
            <li key={order.id} className="border-b border-bambu-dark-tertiary last:border-b-0">
              <button
                type="button"
                aria-current={order.id === shown ? 'true' : undefined}
                onClick={() => {
                  if (order.id !== picked) onPick(order.id);
                }}
                className={rowClass(order.id === shown)}
              >
                <WorkspaceRow order={order} />
              </button>
            </li>
          ))}
        </ul>
        {/* An opaque, pinned page bar: visible without scrolling the list to its end (G02). */}
        <div data-testid="workspace-pager" className="sticky bottom-0 bg-bambu-dark-secondary">
          <PaginationBar
            page={data.meta.current_page}
            totalPages={data.meta.last_page}
            perPage={perPage}
            total={total}
            onPageChange={onPageChange}
            onPerPageChange={onPerPageChange}
            items={t('orders.list.items', { count: total })}
            variant="card"
          />
        </div>
      </div>

      {shown != null && (
        <div ref={paneRef} className="min-w-0 scroll-mt-4">
          {fallback && (
            <p data-testid="workspace-fallback" role="status" className="mb-2 flex flex-wrap items-center gap-2 text-xs text-amber-400">
              {t('orders.workspace.notOnPage', { shown: fallback.code })}
              <Link to={`/projects/${picked}`} className="text-bambu-green hover:underline">
                {t('orders.workspace.openChosen')}
              </Link>
            </p>
          )}
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

/** The mockup's row: padding 14 16, a hover tint, the chosen one in the accent with a 3 px inset rail (G03). */
function rowClass(current: boolean) {
  return `block w-full text-left px-4 py-3.5 space-y-1 scroll-my-12 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-bambu-green ${
    current ? 'bg-bambu-green/10 shadow-[inset_3px_0_0_var(--color-bambu-green)]' : 'hover:bg-bambu-dark-tertiary/40'
  }`;
}

/** code · deadline and the stage, the name, the customer, the coverage — a table row folded into a column. */
function WorkspaceRow({ order }: { order: OrderListItem }) {
  const { t } = useTranslation();
  return (
    <>
      <span className="flex items-center justify-between gap-2 text-xs text-bambu-gray">
        <span className="min-w-0 truncate">
          {order.code}
          {order.due_date && (
            <>
              {' · '}
              <OrderDue order={order} variant="plain" />
            </>
          )}
        </span>
        <span className="flex-shrink-0 whitespace-nowrap">
          <StageBadge stage={order.stage} status={order.status} />
        </span>
      </span>
      <span className="block text-sm font-semibold text-white truncate">{order.name}</span>
      <span className="block text-xs text-bambu-gray truncate">{order.customer_name ?? t('orders.list.noCustomer')}</span>
      <OrderCoverage order={order} variant="row" />
    </>
  );
}
