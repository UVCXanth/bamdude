import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../api/client';
import type { OrderStage } from '../../../api/client';
import { useToast } from '../../../contexts/ToastContext';
import { invalidateOrderViews } from '../../../utils/queryInvalidation';
import { resolveDrop } from './boardDrop';
import type { BoardColumnKey } from './boardDrop';

/**
 * What the kanban does with a drop (spec workshop-order-views, rule 7). The
 * board never rearranges itself: after either write every order view — the
 * board included, it lives under `projects` — is read again from the server.
 */
export function useBoardActions(onComplete: (orderId: number) => void) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  // A drop onto «done» is a door to the issue dialog: an order completes only fully
  // issued (spec workshop-order-issue, rule 28), so the board never writes it — the
  // page's action host opens the dialog (WS-13 E6 B04).

  const onError = (e: Error) => showToast(e.message, 'error');
  const setStage = useMutation({
    mutationFn: ({ id, stage }: { id: number; stage: OrderStage }) => api.setOrderStage(id, stage),
    onSuccess: () => invalidateOrderViews(queryClient),
    onError,
  });
  const drop = (orderId: number, from: BoardColumnKey, to: BoardColumnKey) => {
    const action = resolveDrop(from, to);
    if (action?.kind === 'stage') setStage.mutate({ id: orderId, stage: action.stage });
    else if (action?.kind === 'complete') onComplete(orderId);
  };

  return { drop };
}
