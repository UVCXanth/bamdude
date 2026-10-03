import { useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { api, STOCK_MAX_QTY as MAX_QTY } from '../../api/client';
import type { StockItem } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { invalidateStock } from '../../utils/queryInvalidation';
import { Button } from '../Button';
import { lineConfigLabel } from '../projects/lineConfigLabel';
import { WorkshopDialog } from '../workshop/WorkshopDialog';
import { WorkshopField, WorkshopFormGrid } from '../workshop/WorkshopFormGrid';

const FIELD_CLASS =
  'w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:border-bambu-green focus:outline-none';
const LOCATION_MAX = 64;

/**
 * «Комірка й мінімум» — a position's storage settings, not stock (WS-13 E12 H01): nothing
 * moves and the journal records nothing. An emptied location is «not assigned». The narrow
 * Workshop dialog, with the move dialog's behaviour (G07): the cursor in the first field, a
 * refusal in the slot with the focus on the primary and the fields as typed, one press —
 * one request, nothing closing the dialog while it is on its way.
 */
export function StockParamsDialog({ item, onClose }: { item: StockItem; onClose: () => void }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const uid = useId();
  const ids = { form: `${uid}-form`, location: `${uid}-location`, min: `${uid}-min` };
  const [location, setLocation] = useState(item.location ?? '');
  const [minQty, setMinQty] = useState(String(item.min_qty));

  const sent = useRef(false);
  const save = useMutation({
    mutationFn: () => api.updateStockItem(item.id, { location: location.trim() || null, min_qty: Number(minQty) }),
    onSuccess: () => {
      invalidateStock(queryClient);
      showToast(t('stock.params.saved'));
      onClose();
    },
    onError: () => {
      sent.current = false;
      invalidateStock(queryClient);
    },
  });
  const pending = save.isPending;
  const submitId = `${ids.form}-submit`;
  useEffect(() => {
    if (save.isError) document.getElementById(submitId)?.focus();
  }, [save.isError, save.error, submitId]);
  useEffect(() => {
    document.getElementById(ids.location)?.focus();
    // Once, at the opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const min = Number(minQty);
  const valid = minQty.trim() !== '' && Number.isInteger(min) && min >= 0 && min <= MAX_QTY;
  const close = () => {
    if (sent.current) return;
    onClose();
  };
  const submit = () => {
    if (sent.current || !valid || pending) return;
    sent.current = true;
    save.mutate();
  };

  const caption = lineConfigLabel(item.configuration, 'product', t);
  return (
    <WorkshopDialog
      size="sm"
      onClose={close}
      title={t('stock.params.title')}
      subtitle={[item.product.name, item.code, caption].filter(Boolean).join(' · ')}
      pending={pending}
      error={save.isError ? (save.error as Error).message : undefined}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={close} disabled={pending}>
            {t('common.cancel')}
          </Button>
          <Button
            id={submitId}
            type="submit"
            form={ids.form}
            disabled={!valid || pending}
            aria-describedby={!valid ? `${ids.min}-hint` : undefined}
            data-testid="stock-params-submit"
          >
            {pending && <Loader2 className="w-4 h-4 animate-spin" />}
            {t('stock.params.submit')}
          </Button>
        </>
      }
    >
      <form
        id={ids.form}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <WorkshopFormGrid>
          <WorkshopField label={t('stock.finished.location')} htmlFor={ids.location} hint={t('stock.params.locationHint')}>
            <input
              id={ids.location}
              type="text"
              maxLength={LOCATION_MAX}
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="A-01"
              aria-describedby={`${ids.location}-hint`}
              className={FIELD_CLASS}
            />
          </WorkshopField>
          <WorkshopField
            label={t('stock.params.min')}
            htmlFor={ids.min}
            hint={
              valid ? (
                t('stock.params.minHint')
              ) : (
                <span className="text-status-warning">{t('stock.params.minInvalid')}</span>
              )
            }
          >
            <input
              id={ids.min}
              type="number"
              min={0}
              max={MAX_QTY}
              value={minQty}
              onChange={(e) => setMinQty(e.target.value)}
              aria-describedby={`${ids.min}-hint`}
              aria-invalid={!valid || undefined}
              className={`${FIELD_CLASS} tabular-nums`}
            />
          </WorkshopField>
        </WorkshopFormGrid>
      </form>
    </WorkshopDialog>
  );
}
