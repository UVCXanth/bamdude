import { useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import type { Product, ProductPart } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { Button } from '../Button';
import { Select } from '../Select';
import { WorkshopDialog } from '../workshop/WorkshopDialog';
import { WorkshopField, WorkshopFormGrid } from '../workshop/WorkshopFormGrid';
import { compositionMutationKey, invalidateComposition } from './partMutations';

/** `sort_order` is the authority; `id` only breaks its ties (as the composition tab). */
function byOrder(a: ProductPart, b: ProductPart): number {
  return a.sort_order - b.sort_order || a.id - b.id;
}

interface MergePartDialogProps {
  product: Product;
  /** The part that goes — it is folded into the chosen target and deleted. */
  source: ProductPart;
  onClose: () => void;
  /** Right before the request: the caller arms its watch for the row that leaves. */
  beforeSend?: () => void;
}

/**
 * Merging one printed part into another (WS-13 E10 C08, F15, K5). The server has no
 * preview, so the dialog says what the merge does before it is done — the source's
 * names become the target's aliases, its free stock (by its number) moves across, saved
 * order configurations count it into the target, its purchase records and its variant
 * binding go. A target marked «Not counted» holds no stock, so it is shut while the
 * source has some; every other refusal is the server's, in the dialog.
 *
 * ⚠️ **This part is the SOURCE**: `mergeProductPart(productId, target, source)` deletes
 * it, so the row the menu was opened on is the one that leaves.
 */
export function MergePartDialog({ product, source, onClose, beforeSend }: MergePartDialogProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [targetId, setTargetId] = useState('');
  const targetFieldId = useId();
  const primaryId = useId();

  const targets = product.parts.filter((p) => p.kind === 'printed' && p.id !== source.id).sort(byOrder);
  const holdsNoStock = (target: ProductPart) => source.stock_balance > 0 && target.ignored;
  const chosen = targets.find((p) => String(p.id) === targetId);

  const merge = useMutation({
    mutationKey: compositionMutationKey(product.id),
    mutationFn: (target: number) => api.mergeProductPart(product.id, target, source.id),
    onSuccess: () => {
      invalidateComposition(queryClient, product.id);
      showToast(t('products.mergeDialog.merged'));
      onClose();
    },
  });

  // ⚠️ Synchronous: one press, one request; nothing closes the dialog under it.
  const sent = useRef(false);
  useEffect(() => {
    if (merge.isError) {
      sent.current = false;
      document.getElementById(primaryId)?.focus();
    }
  }, [merge.isError, merge.error, primaryId]);

  const close = () => {
    if (sent.current) return;
    onClose();
  };

  const pending = merge.isPending;
  const canMerge = chosen != null && !holdsNoStock(chosen) && !pending;

  return (
    <WorkshopDialog
      size="md"
      onClose={close}
      title={t('products.mergeDialog.title', { name: source.name })}
      pending={pending}
      error={merge.isError ? (merge.error as Error).message : undefined}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={close} disabled={pending}>
            {t('common.cancel')}
          </Button>
          <Button
            id={primaryId}
            type="button"
            disabled={!canMerge}
            onClick={() => {
              if (sent.current || !chosen || holdsNoStock(chosen)) return;
              sent.current = true;
              beforeSend?.();
              merge.mutate(chosen.id);
            }}
          >
            {t('products.mergeDialog.merge')}
            {pending && '…'}
          </Button>
        </>
      }
    >
      <WorkshopFormGrid>
        <WorkshopField label={t('products.mergeDialog.target')} htmlFor={targetFieldId} full>
          <Select
            id={targetFieldId}
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            disabled={pending}
            className="w-full"
          >
            <option value="">{t('products.mergeDialog.choose')}</option>
            {targets.map((target) => (
              <option key={target.id} value={String(target.id)} disabled={holdsNoStock(target)}>
                {holdsNoStock(target) ? t('products.mergeDialog.holdsNoStock', { name: target.name }) : target.name}
              </option>
            ))}
          </Select>
        </WorkshopField>
      </WorkshopFormGrid>
      {/* Only what applies to THIS source: no stock to move, no binding to lose — no line. */}
      <ul className="list-disc space-y-1 pl-5 text-sm text-bambu-gray-light">
        <li>{t('products.mergeDialog.names', { name: source.name })}</li>
        {source.stock_balance > 0 && <li>{t('products.mergeDialog.stock', { count: source.stock_balance })}</li>}
        <li>{t('products.mergeDialog.orders')}</li>
        <li>{t('products.mergeDialog.procurement')}</li>
        {source.variant_option_id != null && <li>{t('products.mergeDialog.variant')}</li>}
      </ul>
    </WorkshopDialog>
  );
}
