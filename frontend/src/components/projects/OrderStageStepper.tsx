import { useId, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, ORDER_STAGES } from '../../api/client';
import type { Order, OrderStage, OrderStageShown } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { invalidateOrderViews } from '../../utils/queryInvalidation';
import { Select } from '../Select';

const STEPS: readonly OrderStageShown[] = [...ORDER_STAGES, 'done'];

/**
 * The order's four stages (spec workshop-order-stage, rule 33). The stage is set
 * by hand only — whoever is on the farm, and the journal says who; «Done» is
 * reached by marking the order completed, so the select never offers it. A
 * cancelled order has no stage and no stepper.
 *
 * WS-13 E3 D01/D02: pills as in the mockup — every step up to the current one
 * in the accent, the current one ringed — and the manual select at the row's
 * right end. No «auto» option and no «manually» mark: there is no derived stage
 * (E01). A passed step says «passed» to a screen reader, since the pills carry
 * no visible mark and colour alone is not enough (WCAG 1.4.1).
 */
export function OrderStageStepper({ order, canEdit }: { order: Order; canEdit: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const selectId = useId();
  // The stage just chosen, held while the request is in flight so the select
  // does not snap back. Keyed by the stage it was chosen FROM: once the order
  // refetches with another stage, the pick is spent without an effect to clear it.
  const [picked, setPicked] = useState<{ from: OrderStageShown; to: OrderStage } | null>(null);
  const setStage = useMutation({
    mutationFn: (stage: OrderStage) => api.setOrderStage(order.id, stage),
    onSuccess: (saved) => {
      invalidateOrderViews(queryClient, { orderId: order.id });
      if (saved.stage) showToast(t('orders.stage.changed', { stage: t(`orders.stage.${saved.stage}`) }));
    },
    onError: (e: Error) => {
      setPicked(null);
      // Refused — most likely the order was closed elsewhere: show what it is now.
      invalidateOrderViews(queryClient, { orderId: order.id });
      showToast(e.message, 'error');
    },
  });
  if (order.stage == null) return null;
  const current = STEPS.indexOf(order.stage);
  const shown = picked && picked.from === order.stage ? picked.to : order.stage;
  return (
    <div data-testid="order-stage" className="mt-3.5 mb-1 flex flex-wrap items-center gap-1.5">
      <ol aria-label={t('orders.stage.steps')} className="flex flex-wrap items-center gap-1.5">
        {STEPS.map((step, index) => {
          const state = index < current ? 'passed' : index === current ? 'current' : 'future';
          return (
            <li
              key={step}
              data-state={state}
              aria-current={state === 'current' ? 'step' : undefined}
              className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                state === 'future' ? 'bg-bambu-dark-tertiary text-bambu-gray' : 'bg-bambu-green/20 text-bambu-green'
              } ${state === 'current' ? 'ring-1 ring-bambu-green' : ''}`}
            >
              {index + 1}. {t(`orders.stage.${step}`)}
              {state === 'passed' && <span className="sr-only"> {t('orders.stage.passed')}</span>}
            </li>
          );
        })}
      </ol>
      {canEdit && order.status === 'active' && (
        <>
          <label htmlFor={selectId} className="sr-only">
            {t('orders.stage.label')}
          </label>
          <Select
            id={selectId}
            size="sm"
            className="ml-auto min-w-0"
            value={shown}
            disabled={setStage.isPending}
            onChange={(e) => {
              const stage = e.target.value as OrderStage;
              setPicked({ from: order.stage as OrderStageShown, to: stage });
              setStage.mutate(stage);
            }}
          >
            {ORDER_STAGES.map((stage) => (
              <option key={stage} value={stage}>
                {t(`orders.stage.${stage}`)}
              </option>
            ))}
          </Select>
        </>
      )}
    </div>
  );
}
