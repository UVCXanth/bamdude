import { useId, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
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
    <div className="flex items-center gap-3 flex-wrap">
      <ol aria-label={t('orders.stage.steps')} className="flex items-center gap-2 flex-wrap text-xs">
        {STEPS.map((step, index) => (
          <li
            key={step}
            aria-current={index === current ? 'step' : undefined}
            className={`inline-flex items-center gap-1 px-2 py-1 rounded ${
              index === current
                ? 'bg-bambu-green/20 text-bambu-green font-medium'
                : index < current
                  ? 'text-white'
                  : 'text-bambu-gray'
            }`}
          >
            {/* Passed is said by a mark, not by colour alone (WCAG 1.4.1). */}
            {index < current && <Check role="img" aria-label={t('orders.stage.passed')} className="w-3 h-3" />}
            {index + 1}. {t(`orders.stage.${step}`)}
          </li>
        ))}
      </ol>
      {canEdit && order.status === 'active' && (
        <>
          <label htmlFor={selectId} className="sr-only">
            {t('orders.stage.label')}
          </label>
          <Select
            id={selectId}
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
