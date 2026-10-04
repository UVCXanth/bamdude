import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { FolderKanban, Loader2 } from 'lucide-react';
import { api } from '../../api/client';
import { Button } from '../Button';
import { Modal } from '../Modal';
import { useToast } from '../../contexts/ToastContext';
import { OrderChoice } from '../pickers/OrderChoice';
import { OrderLinePicker } from '../pickers/OrderLinePicker';
import { invalidateOrderViews } from '../../utils/queryInvalidation';

interface BatchAssignOrderModalProps {
  archiveIds: number[];
  /** One print's current order and line (its card or row): the dialog opens on
   *  them and offers to take the print out of its order. */
  bound?: { orderId: number | null; lineId: number | null };
  onClose: () => void;
  onDone?: () => void;
}

/**
 * File archives under one order, optionally under one line — a selection from the
 * archives page, or one print from its card or row.
 *
 * Replaces `BatchProjectModal`, which hardcoded its English and hand-rolled a
 * project list beside the shared rule, and the per-print `AddToOrderMenu`, which
 * read every order and searched them in the browser. The pickers are the same two
 * the archive editor uses (WS-13 E13 D03): the server searches the ACTIVE orders,
 * and a print's own order stays visible whatever its status. Changing the order
 * clears the line for the same reason it does there: the server refuses a line
 * from another order. A refusal (403 rights, 409 a print its order received —
 * B03, B05) stays in the dialog in the server's words; nothing was filed.
 */
export function BatchAssignOrderModal({ archiveIds, bound, onClose, onDone }: BatchAssignOrderModalProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [orderId, setOrderId] = useState<number | null>(bound?.orderId ?? null);
  const [lineId, setLineId] = useState<number | null>(bound?.lineId ?? null);
  const [error, setError] = useState<string | null>(null);
  // One press, one request (WS-13 E13 G04): a second press in the same tick — before
  // `isPending` reaches the button — finds the ref set. A refusal frees it for a retry.
  const sent = useRef(false);
  const single = archiveIds.length === 1;
  const canRemove = single && bound?.orderId != null;

  const done = () => {
    queryClient.invalidateQueries({ queryKey: ['archives'] });
    // Prefixes, not the picked order alone — a selection can be pulled out
    // of several other orders, and several customers, in one go. The set
    // itself is decided in `utils/queryInvalidation.ts`.
    invalidateOrderViews(queryClient);
    showToast(t('archives.toast.orderUpdated'));
    onDone?.();
    onClose();
  };

  const refused = (e: Error) => {
    sent.current = false;
    setError(e.message);
  };

  const assign = useMutation({
    mutationFn: (target: number) => api.addArchivesToOrder(target, archiveIds, lineId),
    onMutate: () => setError(null),
    onSuccess: done,
    onError: refused,
  });

  const remove = useMutation({
    // Not `addArchivesToOrder` — there is no order to add to. Clearing the line
    // alongside is not optional: a line without its order is a row the server
    // would refuse on the next edit.
    mutationFn: () => api.updateArchive(archiveIds[0], { project_id: null, project_line_id: null }),
    onMutate: () => setError(null),
    onSuccess: done,
    onError: refused,
  });

  const pending = assign.isPending || remove.isPending;

  return (
    <Modal
      onClose={onClose}
      title={single ? t('archives.menu.addToOrder') : t('archives.bulk.assignOrder.title')}
      icon={<FolderKanban className="w-5 h-5 text-bambu-green" />}
      size="lg"
      closeDisabled={pending}
    >
      <div className="p-4 space-y-4">
        {!single && (
          <p className="text-sm text-bambu-gray">
            {t('archives.bulk.assignOrder.description', { count: archiveIds.length })}
          </p>
        )}

        <div>
          <label htmlFor="batch-assign-order" className="block text-sm text-bambu-gray mb-1">
            {t('archives.bulk.assignOrder.order')}
          </label>
          <OrderChoice
            id="batch-assign-order"
            stacked
            value={orderId}
            onChange={(next) => {
              setOrderId(next?.id ?? null);
              setLineId(null);
            }}
            disabled={pending}
          />
        </div>

        <div>
          <label htmlFor="batch-assign-line" className="block text-sm text-bambu-gray mb-1">
            {t('archives.bulk.assignOrder.line')}
          </label>
          <OrderLinePicker
            id="batch-assign-line"
            orderId={orderId}
            value={lineId}
            onChange={setLineId}
            disabled={pending}
          />
        </div>

        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400 [overflow-wrap:anywhere]">
            {error}
          </p>
        )}
      </div>

      {/* The way out of the order on the left, the two answers on the right. The answers are
          ONE group: where the three do not fit (a phone, a long translation) the pair moves under
          «Remove from order» together — the primary never lands on a row of its own (E13 T9). */}
      <div className="flex flex-wrap items-center justify-end gap-3 p-4 border-t border-bambu-dark-tertiary">
        {canRemove && (
          <Button
            variant="danger"
            className="mr-auto"
            onClick={() => {
              if (sent.current) return;
              sent.current = true;
              remove.mutate();
            }}
            disabled={pending}
          >
            {remove.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            {t('archives.menu.removeFromOrder')}
          </Button>
        )}
        <div className="ml-auto flex gap-3">
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={() => {
              if (orderId == null || sent.current) return;
              sent.current = true;
              assign.mutate(orderId);
            }}
            disabled={orderId == null || pending}
          >
            {assign.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            {t('archives.bulk.assignOrder.assign')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
