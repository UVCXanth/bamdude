import { useCallback, useEffect, useId, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Loader2 } from 'lucide-react';
import { api } from '../../api/client';
import type { ProjectStatus } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { OrderHeader } from './OrderHeader';
import { OrderStageStepper } from './OrderStageStepper';
import { CloseSuggestionBanner } from './CloseSuggestionBanner';
import { OrderFigures } from './OrderFigures';
import { OrderLinesTable } from './OrderLinesTable';
import { PlanBlock } from './PlanBlock';
import { OrderModal } from './OrderModal';
import { OrderCoverDialog } from './OrderCover';
import { ProcurementChecklist } from './ProcurementChecklist';
import { OrderPrints } from './OrderPrints';
import { OrderQueue } from './OrderQueue';
import { OrderTimeline } from './OrderTimeline';
import { OrderNotes } from './OrderNotes';
import { OrderAttachments } from './OrderAttachments';
import { DuplicateOrderModal } from './DuplicateOrderModal';
import { FulfilmentDialog } from './fulfilment/FulfilmentDialog';
import { TakeStockBanner } from './TakeStockBanner';
import { useFulfilment } from '../../hooks/useFulfilment';
import type { FulfilmentMode } from './fulfilment/fulfilmentState';
import { ConfirmModal } from '../ConfirmModal';
import { invalidateAfterDelete, invalidateOrderViews } from '../../utils/queryInvalidation';
import { useForgetOnUnmount } from '../../hooks/useForgetOnUnmount';
import { useOrderDetail } from '../../hooks/useOrderDetail';
import { DispatchNotesSection } from '../stock/DispatchNotesSection';
import { WorkshopPanel } from '../workshop/WorkshopPanel';
import { forecastView } from './orderForecastView';
import { OrderForecastPanel } from './OrderForecastPanel';
import { OrderFilamentPanel } from './OrderFilamentPanel';
import { ORDER_SECTIONS, sectionParam, type OrderSection } from './orderSections';
import { WorkshopTabPanel, WorkshopTabs } from '../workshop/WorkshopTabs';
import { useOrderPlan } from '../../hooks/useOrderPlan';

/**
 * One order: who it is for, what it asks for, and how much of it is printed.
 * The order page and the orders workspace draw this same component (spec
 * workshop-order-views, rule 12); its root is a size container, so its
 * sections lay out by the room they are given, not by the window.
 *
 * The page composes sections and owns nothing but dialog state — every figure
 * comes from `GET /projects/{id}` and is shown as sent (design decision 8).
 * `PlanBlock` below the lines answers the other half: what to print next, and
 * how to send it. It owns its own query and its own what-if counts, so the
 * page hands it the order and the edit permission and nothing else.
 */
export function OrderView({
  id,
  onDeleted,
  embedded = false,
  section: sectionProp,
  onSectionChange,
}: {
  id: number;
  onDeleted: () => void;
  /** Inside another page (the workspace's pane): no breadcrumb out of it, and not the page's heading. */
  embedded?: boolean;
  /** The open section — the owner keeps it in its URL (WS-13 E3 F02); absent, the view keeps its own. */
  section?: OrderSection;
  onSectionChange?: (section: OrderSection) => void;
}) {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const forgetOrder = useForgetOnUnmount(['project', id]);

  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [coverOpen, setCoverOpen] = useState(false);
  const [planDraftChanged, setPlanDraftChanged] = useState(false);
  // When the plan was last sent: until the forecast is read again after it, the
  // cached answer is the previous plan's and is not shown as current (R03).
  const [enqueuedAt, setEnqueuedAt] = useState<number | null>(null);

  // The six sections (WS-13 E3 §F). Controlled by the owner's URL; a view with no
  // owner keeps its own. A section is mounted on its first visit and KEPT — hidden
  // — from then on, so a draft in the notes or the plan survives a look at another
  // tab, and a section nobody opened asks the server nothing (F04).
  const [ownSection, setOwnSection] = useState<OrderSection>('plan');
  const section = sectionProp ?? ownSection;
  const selectSection = (next: OrderSection) => {
    if (onSectionChange) onSectionChange(next);
    else setOwnSection(next);
  };
  const [visited, setVisited] = useState<ReadonlySet<OrderSection>>(() => new Set([section]));
  if (!visited.has(section)) setVisited(new Set([...visited, section]));
  const tabsId = useId();
  // The plan tab's count READS the plan block's query and never fetches for itself
  // (E1 CN2): no parentheses until the plan has been asked for, «(—)» while it is read.
  const planForCount = useOrderPlan(id, false);
  // The issue dialog, and how it opens (spec workshop-order-issue, rules 26–28).
  const [fulfilling, setFulfilling] = useState<{ mode: FulfilmentMode; complete: boolean } | null>(null);

  useEffect(() => setPlanDraftChanged(false), [id]);

  const {
    data: order,
    isLoading,
    isError,
    error,
  } = useOrderDetail(id);

  // Only an active order can still be simulated forward — a completed or
  // cancelled one has nothing left to schedule.
  // What the order could assemble, receive and issue now — the header button, the
  // banner's counts. Only an active order has anything to issue.
  const fulfilment = useFulfilment(
    Number.isFinite(id) ? id : null,
    order?.status === 'active' && hasPermission('projects:update'),
  );

  const forecast = useQuery({
    queryKey: ['order-forecast', id],
    queryFn: () => api.getOrderForecast(id),
    enabled: Number.isFinite(id) && order?.status === 'active',
    staleTime: 30_000,
  });

  // After a send the forecast is READ AGAIN (E3-V02). The invalidation that follows
  // the send cannot promise it: a query still waiting for its first answer hands that
  // in-flight read back instead of starting one, and its late answer — the previous
  // plan's — would land after the send and pass for fresh. Dropping the in-flight read
  // and asking anew makes every answer that lands after `enqueuedAt` one asked after it.
  const onPlanSent = useCallback(() => {
    setEnqueuedAt(Date.now());
    const queryKey = ['order-forecast', id];
    void queryClient
      .cancelQueries({ queryKey })
      .then(() => queryClient.refetchQueries({ queryKey, type: 'active' }));
  }, [queryClient, id]);

  // The customer keys go too, and as prefixes — their tiles are computed
  // from this order and its siblings, and with a 60 s `staleTime` a key left
  // un-invalidated is not refetched on navigation for a minute, which is long
  // enough to read a fresh grid under stale totals. The set itself is one
  // decision, in `utils/queryInvalidation.ts`.
  const invalidate = () => invalidateOrderViews(queryClient, { orderId: id });

  const setStatus = useMutation({
    mutationFn: (status: ProjectStatus) => api.updateOrder(id, { status }),
    onSuccess: invalidate,
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  /**
   * «Bank the surplus» — the order's overprint onto its products' shelves.
   *
   * ⚠️ **Two caches move, not one.** The order's own figures change (the
   * banked surplus is no longer bankable, so the button goes dark) AND every
   * product view that shows `kits_available` — the catalog cards, the product
   * page's stock section, and the stock the line dialog offers. Both halves are
   * in `ORDER_VIEW_KEYS` since Ruling 29, so one call covers them; invalidating
   * the product keys again here would be a second refetch of the same pages.
   *
   * ⚠️ **`nothing_to_bank` is a SUCCESS.** It is the answer to a second press —
   * the surplus was already banked — so it gets a neutral toast, never an error.
   */
  const bankSurplus = useMutation({
    mutationFn: () => api.bankOrderSurplus(id),
    onSuccess: (result) => {
      invalidate();
      if (result.nothing_to_bank) {
        showToast(t('stock.bank.nothing'), 'info');
        return;
      }
      // Data, not keys: the parts and their counts come back from the server,
      // and the product is the one (or ones) the order's lines name — the
      // response is aggregated per PART, so it cannot say which product a part
      // belongs to and the order is the only place that knows.
      const moved = result.moved.map((m) => `${m.delta} ${m.name}`).join(', ');
      const products = [...new Set((order?.lines ?? []).map((line) => line.product_name))].join(', ');
      showToast(t('stock.bank.done', { moved, product: products }));
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  const remove = useMutation({
    mutationFn: () => api.deleteOrder(id),
    // ⚠️ The LISTS only. Marking `['project', id]` stale asks TanStack to
    // refetch an order that no longer exists while this page is still
    // mounted, which lands a 404 in the query on the way out.
    onSuccess: () => {
      invalidateAfterDelete(queryClient, 'order');
      showToast(t('orders.toast.deleted'));
      // ⚠️ The entry goes when this page UNMOUNTS, not on the next line: a
      // `removeQueries` here would run while the page is still mounted (React
      // has only scheduled the route change) and its own observer would refetch
      // the order that was just deleted. Armed here, dropped on unmount — see
      // `useForgetOnUnmount`. Without it a Back inside the 60 s `staleTime`
      // renders the deleted order out of cache. `onDeleted` is the owner's way
      // out — the route leaves for the list, the workspace moves its pane on
      // (and keys this view by id, so the old one unmounts and forgets).
      forgetOrder();
      onDeleted();
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  // The page's way back to the list (spec B03): above the header, outside it, and
  // there in the loading and error states too (B05). The workspace has none — its
  // list is beside it, and a crumb would lead to a bare /projects.
  const crumbs = embedded ? null : (
    <nav aria-label={t('orders.header.breadcrumbLabel')} className="mb-3 flex min-w-0 items-center gap-1 text-sm text-bambu-gray">
      <Link to="/projects" className="shrink-0 hover:text-white transition-colors">
        {t('orders.header.breadcrumb')}
      </Link>
      {order && (
        <>
          <ChevronRight className="w-4 h-4 shrink-0" aria-hidden />
          <span className="min-w-0 truncate text-white">{order.name}</span>
        </>
      )}
    </nav>
  );

  if (isLoading) {
    return (
      <div className={embedded ? '' : 'p-4'}>
        {crumbs}
        <div className="flex items-center gap-2 text-bambu-gray">
          <Loader2 className="w-4 h-4 animate-spin" />
          {t('common.loading')}
        </div>
      </div>
    );
  }
  // ⚠️ Data presence first, then `isError` — see the long note on ProductPage.
  // TanStack v5 flips `status` to "error" on any failed fetch, a background
  // REFETCH of a query still holding good data included, and this page
  // invalidates `['project', id]` on every mutation its sections make. An
  // `isError`-first check would throw the whole rendered order away because a
  // refetch blipped. With no data the two cases still read apart: a fetch that
  // FAILED is not an order that was deleted.
  if (!order) {
    return (
      <div className={embedded ? '' : 'p-4'}>
        {crumbs}
        {isError ? (
          <div className="text-sm text-red-500">
            {t('orders.page.loadFailed')} {(error as Error)?.message}
          </div>
        ) : (
          <div className="text-bambu-gray text-sm">{t('orders.page.notFound')}</div>
        )}
      </div>
    );
  }

  const canEdit = hasPermission('projects:update');
  const forecastNow = forecastView({
    active: order.status === 'active',
    draft: planDraftChanged,
    sentAt: enqueuedAt,
    dataUpdatedAt: forecast.dataUpdatedAt,
    errorUpdatedAt: forecast.errorUpdatedAt,
    data: forecast.data,
    isError: forecast.isError,
  });

  function sectionBody(value: OrderSection) {
    if (!order) return null;
    switch (value) {
      case 'plan':
        return (
          <PlanBlock
            order={order}
            canEdit={canEdit}
            onDraftChanged={setPlanDraftChanged}
            onEnqueued={onPlanSent}
          />
        );
      case 'prints':
        return <OrderPrints order={order} canEdit={canEdit} />;
      case 'procurement':
        return <ProcurementChecklist order={order} canEdit={canEdit} />;
      case 'issues':
        return <DispatchNotesSection projectId={order.id} canEdit={canEdit} inTab />;
      case 'notes':
        return <OrderNotes order={order} canEdit={canEdit} />;
      case 'files':
        return <OrderAttachments order={order} canEdit={canEdit} />;
    }
  }

  // Zones in reading order (WS-13 E3 B01): head (title, facts, actions, the stage
  // row) → banners → the grid of ONE main panel and the side column. The grid's
  // columns are the named container's call (`.order-view*` in index.css), not
  // the window's.
  return (
    // The page's own padding is the view's (the mockup's #app 16); inside the
    // workspace the list page has one already (H01).
    <div data-testid="order-view" className={embedded ? 'order-view' : 'order-view p-4'}>
      {crumbs}
      <div data-testid="order-head" className="border-b border-bambu-dark-tertiary pb-3 mb-4">
          <OrderHeader
            order={order}
            onEdit={() => setEditing(true)}
            onDuplicate={() => setDuplicating(true)}
            onDelete={() => setDeleting(true)}
            // An order completes only fully issued (rule 12): «Mark completed» is the
            // issue dialog prefilled with everything and ticked to close.
            onSetStatus={(status) =>
              status === 'completed' ? setFulfilling({ mode: 'all', complete: true }) : setStatus.mutate(status)
            }
            fulfilment={
              fulfilment.data &&
              (fulfilment.data.can_issue > 0 || fulfilment.data.can_receive > 0 || fulfilment.data.can_assemble > 0)
                ? { onOpen: () => setFulfilling({ mode: 'all', complete: false }), primary: order.stage === 'qc' }
                : undefined
            }
            onBankSurplus={() => bankSurplus.mutate()}
            bankingSurplus={bankSurplus.isPending}
            onCover={() => setCoverOpen(true)}
            embedded={embedded}
            openHref={`/projects/${order.id}${sectionParam(section) ? `?section=${sectionParam(section)}` : ''}`}
          />

      <OrderStageStepper order={order} canEdit={canEdit} />
      </div>

      <div data-testid="order-banners" className="space-y-4 [&:not(:empty)]:mb-4">
        {canEdit && (
          <CloseSuggestionBanner
            order={order}
            state={fulfilment.data}
            onFulfil={(mode, complete) => setFulfilling({ mode, complete })}
          />
        )}
        {canEdit && order.status === 'active' && <TakeStockBanner orderId={order.id} lines={order.lines} />}
      </div>

      <div data-testid="order-grid" className="order-view-grid">
        <WorkshopPanel data-testid="order-main" className="min-w-0">
          <div className="space-y-6">
            <OrderFigures figures={order.figures} forecast={forecastNow} />

            <OrderLinesTable order={order} canEdit={canEdit} headingLevel={embedded ? 3 : 2} />

            <div className="!mt-5">
              <WorkshopTabs
                idBase={tabsId}
                ariaLabel={t('orders.detail.tabsLabel')}
                value={section}
                items={ORDER_SECTIONS.map((value) => ({
                  value,
                  label: t(`orders.detail.tabs.${value}`),
                  count:
                    value === 'plan'
                      ? planForCount.data
                        ? planForCount.data.totals.rows
                        : planForCount.isFetching
                          ? null
                          : undefined
                      : value === 'prints'
                        ? order.counts.prints
                        : value === 'issues'
                          ? order.counts.issues
                          : undefined,
                }))}
                onChange={selectSection}
                size="detail"
                panels="all"
              />
              {ORDER_SECTIONS.map((value) => (
                <WorkshopTabPanel key={value} idBase={tabsId} value={value} hidden={value !== section} className="pt-4">
                  {visited.has(value) && sectionBody(value)}
                </WorkshopTabPanel>
              ))}
            </div>
          </div>
        </WorkshopPanel>

        {/* Forecast (active orders only), filament, queue, activity (WS-13 E3 G01). */}
        <div data-testid="order-side" className="order-view-side">
          {order.status === 'active' && (
            <OrderForecastPanel
              view={forecastNow}
              remaining={order.figures.remaining}
              onRetry={() => forecast.refetch()}
              headingLevel={embedded ? 3 : 2}
            />
          )}
          <OrderFilamentPanel orderId={order.id} active={order.status === 'active'} headingLevel={embedded ? 3 : 2} />
          <OrderQueue orderId={order.id} headingLevel={embedded ? 3 : 2} />
          <OrderTimeline orderId={order.id} headingLevel={embedded ? 3 : 2} />
        </div>
      </div>

      {editing && <OrderModal order={order} onClose={() => setEditing(false)} />}

      {duplicating && <DuplicateOrderModal order={order} onClose={() => setDuplicating(false)} />}

      {coverOpen && <OrderCoverDialog order={order} onClose={() => setCoverOpen(false)} />}

      {fulfilling && (
        <FulfilmentDialog
          orderId={order.id}
          mode={fulfilling.mode}
          complete={fulfilling.complete}
          onClose={() => setFulfilling(null)}
        />
      )}

      {deleting && (
        <ConfirmModal
          title={t('orders.confirm.deleteTitle')}
          message={t('orders.confirm.deleteBody')}
          variant="danger"
          isLoading={remove.isPending}
          onConfirm={() => remove.mutate()}
          onCancel={() => setDeleting(false)}
        />
      )}
    </div>
  );
}
