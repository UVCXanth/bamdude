import { useState } from 'react';
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
export function useBoardActions() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [confirming, setConfirming] = useState<number | null>(null);

  const onError = (e: Error) => showToast(e.message, 'error');
  const setStage = useMutation({
    mutationFn: ({ id, stage }: { id: number; stage: OrderStage }) => api.setOrderStage(id, stage),
    onSuccess: () => invalidateOrderViews(queryClient),
    onError,
  });
  const complete = useMutation({
    mutationFn: (id: number) => api.updateOrder(id, { status: 'completed' }),
    onSuccess: () => {
      invalidateOrderViews(queryClient);
      setConfirming(null);
    },
    onError,
  });

  const drop = (orderId: number, from: BoardColumnKey, to: BoardColumnKey) => {
    const action = resolveDrop(from, to);
    if (action?.kind === 'stage') setStage.mutate({ id: orderId, stage: action.stage });
    else if (action?.kind === 'complete') setConfirming(orderId);
  };

  return {
    drop,
    confirming,
    completing: complete.isPending,
    confirm: () => {
      if (confirming != null) complete.mutate(confirming);
    },
    cancel: () => setConfirming(null),
  };
}
