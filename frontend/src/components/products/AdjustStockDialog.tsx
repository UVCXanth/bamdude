import { useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { api } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { useProductStock } from '../../hooks/useProductStock';
import { invalidateStock } from '../../utils/queryInvalidation';
import { Button } from '../Button';
import { Select } from '../Select';
import { LoadFailedNote } from '../workshop/LoadFailedNote';
import { WorkshopDialog } from '../workshop/WorkshopDialog';
import { WorkshopField, WorkshopFormGrid } from '../workshop/WorkshopFormGrid';

const FIELD_CLASS =
  'w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white focus:border-bambu-green focus:outline-none';
const NOTE_MAX = 500;

interface AdjustStockDialogProps {
  productId: number;
  productName: string;
  /** The part to start on; the operator's own pick otherwise. */
  initialPartId?: number;
  onClose: () => void;
}

/**
 * The hand correction of free parts (WS-13 E10 I01–I03, F25): the operator counted the
 * shelf and it disagreed with us.
 *
 * ⚠️ **The dialog reads the shelf itself** (`useProductStock`, the one declaration of
 * `['product-stock', id]`, R07) — both doors hand it only the product. «Now N → will be
 * N + Δ» is a projection of the typed number over a SUCCESSFUL, CURRENT read (K17), not a
 * sum of rows: while the shelf is read it is «…», after a failed read it is not shown at
 * all (the server is the guard), and below zero it says so and «Save» waits.
 *
 * A refusal (409 below zero, 422 a part that holds no stock) stays in the dialog, and the
 * shelf is read again — the part, the change and the reason stay as typed, nothing is
 * sent again by itself. A part the new read no longer holds is said so; it is never
 * swapped for another. Only counted parts are offered: the shelf's own list.
 */
export function AdjustStockDialog({ productId, productName, initialPartId, onClose }: AdjustStockDialogProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const ids = { part: useId(), delta: useId(), note: useId(), form: useId() };

  const stock = useProductStock(productId);
  const balances = stock.data?.balances ?? [];

  // The choice is fixed at the first read (or handed over) and never moves by itself.
  const [part, setPart] = useState<{ id: number; name: string } | null>(null);
  let chosen = part;
  if (chosen == null) {
    const first = initialPartId != null ? balances.find((b) => b.part_id === initialPartId) : balances[0];
    if (first) {
      chosen = { id: first.part_id, name: first.name };
      setPart(chosen);
    } else if (initialPartId != null) {
      chosen = { id: initialPartId, name: `#${initialPartId}` };
    }
  }
  const balance = chosen ? balances.find((b) => b.part_id === chosen.id) : undefined;
  const partGone = stock.data != null && chosen != null && balance == null;

  const [delta, setDelta] = useState('1');
  const [note, setNote] = useState('');
  // After a refusal the shelf is read again; until it answers nothing is projected.
  const [rereading, setRereading] = useState(false);

  const parsed = Number(delta);
  const deltaValid = delta.trim() !== '' && Number.isInteger(parsed) && parsed !== 0;
  const noteValid = note.trim() !== '';
  const fresh = stock.data != null && !stock.isError && !rereading;
  const next = balance && deltaValid ? balance.balance + parsed : null;
  const below = fresh && next != null && next < 0;

  // The cursor starts in the first field (J).
  useEffect(() => {
    document.getElementById(ids.part)?.focus();
    // Once, at the opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ⚠️ Synchronous: one press, one correction; nothing closes the dialog under it.
  const sent = useRef(false);
  const adjust = useMutation({
    mutationFn: (body: { part_id: number; delta: number; note: string }) => api.adjustProductStock(productId, body),
    onSuccess: () => {
      // Once, here: the shelf and its journal, the product's kits and the catalog's figures
      // are all the stock helper's keys — the doors add nothing of their own.
      invalidateStock(queryClient);
      showToast(t('stock.adjust.saved'));
      onClose();
    },
    onError: () => {
      sent.current = false;
      setRereading(true);
      void stock.refetch().finally(() => setRereading(false));
    },
  });
  const pending = adjust.isPending;
  const submitId = `${ids.form}-submit`;
  useEffect(() => {
    if (adjust.isError) document.getElementById(submitId)?.focus();
  }, [adjust.isError, adjust.error, submitId]);

  const close = () => {
    if (sent.current) return;
    onClose();
  };

  const canSave = !pending && chosen != null && !partGone && deltaValid && noteValid && !below;
  const submit = () => {
    if (sent.current || !canSave || chosen == null) return;
    sent.current = true;
    adjust.mutate({ part_id: chosen.id, delta: parsed, note: note.trim() });
  };

  let projection;
  if (stock.isError && !rereading) {
    projection = <LoadFailedNote message={t('stock.adjust.loadFailed')} onRetry={() => stock.refetch()} />;
  } else {
    const text = !fresh
      ? '…'
      : next != null && balance
        ? below
          ? `${t('stock.adjust.projection', { now: balance.balance, next })} — ${t('stock.adjust.belowZero')}`
          : t('stock.adjust.projection', { now: balance.balance, next })
        : '';
    projection = (
      <p
        data-testid="stock-adjust-projection"
        className={`text-sm tabular-nums ${below ? 'text-amber-700 dark:text-amber-400' : 'text-bambu-gray-light'}`}
      >
        {text}
      </p>
    );
  }

  return (
    <WorkshopDialog
      size="md"
      onClose={close}
      title={t('stock.adjust.title')}
      subtitle={productName}
      pending={pending}
      error={adjust.isError ? (adjust.error as Error).message : undefined}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={close} disabled={pending}>
            {t('common.cancel')}
          </Button>
          <Button id={submitId} type="submit" form={ids.form} disabled={!canSave} data-testid="stock-adjust-submit">
            {pending && <Loader2 className="w-4 h-4 animate-spin" />}
            {pending ? t('stock.adjust.saving') : t('stock.adjust.submit')}
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
          <WorkshopField
            label={t('stock.adjust.part')}
            htmlFor={ids.part}
            hint={partGone ? t('stock.adjust.partGone') : undefined}
          >
            <Select
              id={ids.part}
              className="w-full"
              value={chosen?.id ?? ''}
              onChange={(e) => {
                const picked = balances.find((b) => b.part_id === Number(e.target.value));
                if (picked) setPart({ id: picked.part_id, name: picked.name });
              }}
              aria-describedby={partGone ? `${ids.part}-hint` : undefined}
              aria-invalid={partGone || undefined}
              disabled={pending}
            >
              {chosen != null && balance == null && <option value={chosen.id}>{chosen.name}</option>}
              {balances.map((b) => (
                <option key={b.part_id} value={b.part_id}>
                  {t('stock.adjust.partOption', { name: b.name, count: b.balance })}
                </option>
              ))}
            </Select>
          </WorkshopField>
          <WorkshopField
            label={t('stock.adjust.delta')}
            htmlFor={ids.delta}
            hint={!deltaValid ? t('stock.adjust.deltaHint') : undefined}
          >
            <input
              id={ids.delta}
              type="number"
              step={1}
              value={delta}
              onChange={(e) => setDelta(e.target.value)}
              aria-describedby={!deltaValid ? `${ids.delta}-hint` : undefined}
              className={`${FIELD_CLASS} tabular-nums`}
              disabled={pending}
            />
          </WorkshopField>
          <WorkshopField
            label={t('stock.adjust.note')}
            htmlFor={ids.note}
            hint={!noteValid ? t('stock.adjust.noteHint') : undefined}
            full
          >
            <input
              id={ids.note}
              type="text"
              maxLength={NOTE_MAX}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t('stock.adjust.notePlaceholder')}
              aria-describedby={!noteValid ? `${ids.note}-hint` : undefined}
              className={FIELD_CLASS}
              disabled={pending}
            />
          </WorkshopField>
        </WorkshopFormGrid>
        {projection}
      </form>
    </WorkshopDialog>
  );
}
