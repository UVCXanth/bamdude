import { useCallback, useState } from 'react';
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

  // WS-13 E7 F05: the cards whose stage is on its way — one write per card at a
  // time, whichever door asked (a drop or the stage menu); other cards stay free.
  // Hook-level callbacks, because they fire for EVERY mutation, not only the last.
  const [pendingIds, setPendingIds] = useState<ReadonlySet<number>>(() => new Set());
  const hold = useCallback((id: number, on: boolean) => {
    setPendingIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const write = useMutation({
    mutationFn: ({ id, stage }: { id: number; stage: OrderStage }) => api.setOrderStage(id, stage),
    onMutate: ({ id }) => hold(id, true),
    onSuccess: () => invalidateOrderViews(queryClient),
    onError: (e: Error) => showToast(e.message, 'error'),
    onSettled: (_data, _error, { id }) => hold(id, false),
  });
  const setStage = (orderId: number, stage: OrderStage) => {
    if (pendingIds.has(orderId)) return;
    write.mutate({ id: orderId, stage });
  };
  const drop = (orderId: number, from: BoardColumnKey, to: BoardColumnKey) => {
    const action = resolveDrop(from, to);
    if (action?.kind === 'stage') setStage(orderId, action.stage);
    else if (action?.kind === 'complete') onComplete(orderId);
  };

  return { drop, setStage, pendingIds };
}
