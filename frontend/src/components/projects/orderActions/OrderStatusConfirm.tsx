import { useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../../api/client';
import { useToast } from '../../../contexts/ToastContext';
import { invalidateAfterDelete, invalidateOrderViews } from '../../../utils/queryInvalidation';
import { Button } from '../../Button';
import { WorkshopDialog } from '../../workshop/WorkshopDialog';
import type { OrderRef } from './orderRef';

export type OrderConfirmKind = 'cancel' | 'reopen' | 'delete';

/**
 * The confirmations of an order's lifecycle (WS-13 E6 B05, F27 for the order): the
 * order named, what THIS action does to it, a dismiss and a primary named for the
 * action. A refusal stays in the dialog with the server's sentence — a 409 on
 * reopening says why and runs nothing after it (R01).
 *
 * `onDeleted` — set by a view that observes the order's own query (the detail): it
 * forgets the entry on unmount, so the list keys are dropped without the id. A list
 * passes none, and the order's own entry goes with the id (no observer would ever
 * clear it).
 */
export function OrderStatusConfirm({
  kind,
  order,
  onClose,
  onDeleted,
  onPageDeleted,
}: {
  kind: OrderConfirmKind;
  order: OrderRef;
  onClose: () => void;
  onDeleted?: () => void;
  onPageDeleted?: (id: number) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  // A second click in the same tick sees `isPending` still false — the ref is what
  // makes «one click, one request» hold (E6 I4.6); a refusal re-arms it.
  const sent = useRef(false);

  const write = useMutation({
    mutationFn: async () => {
      if (kind === 'delete') await api.deleteOrder(order.id);
      else await api.updateOrder(order.id, { status: kind === 'cancel' ? 'cancelled' : 'active' });
    },
    onSuccess: () => {
      if (kind === 'delete') {
        if (onDeleted) {
          invalidateAfterDelete(queryClient, 'order');
          onDeleted();
        } else {
          invalidateAfterDelete(queryClient, 'order', order.id);
        }
        onPageDeleted?.(order.id);
        showToast(t('orders.toast.deleted'));
      } else {
        invalidateOrderViews(queryClient, { orderId: order.id });
        showToast(t(kind === 'cancel' ? 'orders.toast.cancelled' : 'orders.toast.reopened'));
      }
      onClose();
    },
    onError: () => {
      sent.current = false;
    },
  });

  const body =
    kind === 'cancel'
      ? t('orders.confirm.cancelBody')
      : kind === 'delete'
        ? t('orders.confirm.deleteBody')
        : order.status === 'completed'
          ? t('orders.confirm.reopenCompletedBody')
          : t('orders.confirm.reopenCancelledBody');

  return (
    <WorkshopDialog
      size="sm"
      onClose={onClose}
      title={t(`orders.confirm.${kind}Title`)}
      subtitle={`${order.code} · ${order.name}`}
      pending={write.isPending}
      error={write.isError ? (write.error as Error).message : undefined}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={write.isPending}>
            {t(kind === 'cancel' ? 'orders.confirm.cancelNo' : 'common.cancel')}
          </Button>
          <Button
            variant={kind === 'reopen' ? 'primary' : 'danger'}
            disabled={write.isPending}
            onClick={() => {
              if (sent.current) return;
              sent.current = true;
              write.mutate();
            }}
          >
            {t(`orders.confirm.${kind}Yes`)}
          </Button>
        </>
      }
    >
      {/* The mockup's confirmation body is the secondary text colour (`.m-confirm`). */}
      <p className="text-sm text-bambu-gray-light">{body}</p>
    </WorkshopDialog>
  );
}
