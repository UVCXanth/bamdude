import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
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
import { OrderCover } from './OrderCover';
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
}: {
  id: number;
  onDeleted: () => void;
  /** Inside another page (the workspace's pane): no breadcrumb out of it, and not the page's heading. */
  embedded?: boolean;
}) {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const forgetOrder = useForgetOnUnmount(['project', id]);

  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [planDraftChanged, setPlanDraftChanged] = useState(false);
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

  if (isLoading) {
    return (
      <div className="p-4 flex items-center gap-2 text-bambu-gray">
        <Loader2 className="w-4 h-4 animate-spin" />
        {t('common.loading')}
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
    return isError ? (
      <div className="p-4 text-sm text-red-500">
        {t('orders.page.loadFailed')} {(error as Error)?.message}
      </div>
    ) : (
      <div className="p-4 text-bambu-gray text-sm">{t('orders.page.notFound')}</div>
    );
  }

  const canEdit = hasPermission('projects:update');

  return (
    <div className="@container p-4 space-y-4">
      {/* The cover sits in the header's right column without OrderHeader
          knowing about it — the header owns the actions row, this owns the
          picture, and neither has to grow a slot for the other. */}
      <div className="flex items-start gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
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
            embedded={embedded}
          />
        </div>
        <OrderCover order={order} canEdit={canEdit} />
      </div>

      <OrderStageStepper order={order} canEdit={canEdit} />

      {canEdit && (
        <CloseSuggestionBanner
          order={order}
          state={fulfilment.data}
          onFulfil={(mode, complete) => setFulfilling({ mode, complete })}
        />
      )}

      {canEdit && order.status === 'active' && <TakeStockBanner orderId={order.id} />}

      <OrderFigures
        figures={order.figures}
        forecast={order.status === 'active' ? forecast.data ?? null : null}
        forecastStale={order.status === 'active' && planDraftChanged}
      />

      <OrderLinesTable order={order} canEdit={canEdit} />

      <PlanBlock order={order} canEdit={canEdit} onDraftChanged={setPlanDraftChanged} />

      <ProcurementChecklist order={order} canEdit={canEdit} />

      <OrderPrints order={order} canEdit={canEdit} />

      <OrderQueue orderId={order.id} />

      <DispatchNotesSection projectId={order.id} canEdit={canEdit} hideWhenEmpty />

      <OrderTimeline orderId={order.id} />

      <OrderNotes order={order} canEdit={canEdit} />

      <OrderAttachments order={order} canEdit={canEdit} />

      {editing && <OrderModal order={order} onClose={() => setEditing(false)} />}

      {duplicating && <DuplicateOrderModal order={order} onClose={() => setDuplicating(false)} />}

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
