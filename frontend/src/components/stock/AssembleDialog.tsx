import { useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { api } from '../../api/client';
import type { LineConfiguration, StockAssembleBody, StockItem } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { invalidateStock } from '../../utils/queryInvalidation';
import { Button } from '../Button';
import { lineConfigLabel } from '../projects/lineConfigLabel';
import { LoadFailedNote } from '../workshop/LoadFailedNote';
import { RefreshFailedNote } from '../workshop/RefreshFailedNote';
import { WorkshopDialog } from '../workshop/WorkshopDialog';
import { WorkshopField, WorkshopFormGrid } from '../workshop/WorkshopFormGrid';
import { StockProductChoice } from './StockProductChoice';
import { useStockTarget } from './useStockTarget';

const FIELD_CLASS =
  'w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:border-bambu-green focus:outline-none';
const NOTE_MAX = 500;

/**
 * Assembling finished goods from free parts (spec workshop-finished-goods; WS-13 E12 H02–H04)
 * — one server operation over both ledgers: the kit's printed parts leave the free shelf
 * and the position of THAT configuration grows.
 *
 * Three doors (R01): a position — its configuration is fixed; a product (a free-parts row,
 * the product page) — the product is fixed and its groups are chosen, starting at their
 * standards («No choice» for a group without one, R11); the stock page's header — the
 * product is chosen too. «Assemble» is never blocked by a zero on the way in: the answer
 * of the chosen configuration decides.
 *
 * The kit, the shelf, K and the position come from a CURRENT read only (G08, through
 * `useStockTarget`); a configuration that makes nothing says so and waits while another
 * one stays a choice away. A one-off product is refused by the server — the primary says
 * why first. Purchased parts are not on a shelf and are not written off.
 */
export function AssembleDialog({
  item,
  productId: forProduct,
  onClose,
}: {
  item?: StockItem;
  /** Opened for one product (a free-parts row, the product page — R01): the product is
   *  named, the configuration — and so what can be assembled — is chosen here. */
  productId?: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const uid = useId();
  const ids = { form: `${uid}-form`, product: `${uid}-product`, qty: `${uid}-qty`, note: `${uid}-note`, why: `${uid}-why` };

  const [productId, setProductId] = useState<number | null>(forProduct ?? null);
  const [choices, setChoices] = useState<Record<number, number>>({});
  const [qty, setQty] = useState('1');
  const [note, setNote] = useState('');

  const options = Object.values(choices);
  const { product, groupsReady, lookup, lookupCurrent, lookupOwn, lookupShown, detail, figures, shownFigures, reread, rereading } =
    useStockTarget({
      item,
      productId,
      options,
    });
  // What the shelf answers for the chosen configuration — a current read only.
  const source = item ? figures : lookupCurrent ? lookupOwn : undefined;
  // What is SHOWN: the current answer, or — while the same key is read again — the last one this
  // dialog read, dimmed (F6 D1); the primary never judges by it.
  const shown = item ? shownFigures : lookupShown;
  const stale = source == null && shown != null;
  const parts = shown?.parts ?? [];
  const canAssemble = source?.can_assemble;
  const shownCan = shown?.can_assemble;
  const oneOff = item == null && product.data != null && product.data.origin !== 'catalog';

  const count = Number(qty);
  const countValid = qty.trim() !== '' && Number.isInteger(count) && count >= 1;
  const over = canAssemble != null && countValid && count > canAssemble;
  const shownOver = shownCan != null && countValid && count > shownCan;

  // The position this assembly grows: the fixed one, or the lookup's (none yet — a new one).
  const target: { code: string; configuration: LineConfiguration; onHand: number } | null | undefined = item
    ? shownFigures
      ? { code: item.code, configuration: item.configuration, onHand: shownFigures.on_hand }
      : undefined
    : lookupShown
      ? lookupShown.item
        ? { code: lookupShown.item.code, configuration: lookupShown.configuration, onHand: lookupShown.item.on_hand }
        : null
      : undefined;

  let why: { text: string; id: string } | null = null;
  if (oneOff) why = { text: t('stock.page.oneOffAssemble'), id: ids.why };
  else if (canAssemble === 0) why = { text: t('stock.item.noKits'), id: ids.why };
  else if (!countValid) why = { text: t('stock.move.qtyInvalid'), id: `${ids.qty}-hint` };
  else if (over) why = { text: t('stock.move.overLimit', { n: canAssemble }), id: `${ids.qty}-hint` };

  // ⚠️ Synchronous: one press, one assembly; nothing closes the dialog under it.
  const sent = useRef(false);
  // A refusal hands the focus back once the re-read has answered (below).
  const refocus = useRef(false);
  const assemble = useMutation({
    mutationFn: (body: StockAssembleBody) => api.assembleStock(body),
    onSuccess: () => {
      invalidateStock(queryClient);
      showToast(t('stock.assemble.done'));
      onClose();
    },
    // The refusal says what the server saw; the shelf is read again (G07) — the draft stays.
    onError: () => {
      sent.current = false;
      refocus.current = true;
      invalidateStock(queryClient);
      reread();
    },
  });
  const pending = assemble.isPending;
  const submitId = `${ids.form}-submit`;

  // The cursor starts in the first field (G07): the product from the header, else the count.
  useEffect(() => {
    document.getElementById(item == null && forProduct == null ? ids.product : ids.qty)?.focus();
    // Once, at the opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = () => {
    if (sent.current) return;
    onClose();
  };

  const canSubmit = !pending && canAssemble != null && why == null;

  // After a refusal: once the shelf has been read again, the primary when it can act, else the
  // count — a disabled button cannot hold the focus (E12 pilot).
  useEffect(() => {
    if (!refocus.current || rereading || pending) return;
    refocus.current = false;
    // A focus the operator placed meanwhile is theirs (final review I2): only a lost one — on
    // the page, or still on the primary that went grey — is given back.
    const active = document.activeElement;
    if (active && active !== document.body && active.id !== submitId) return;
    document.getElementById(canSubmit ? submitId : ids.qty)?.focus();
  });
  const submit = () => {
    if (sent.current || !canSubmit) return;
    sent.current = true;
    assemble.mutate({
      ...(item ? { item_id: item.id } : { product_id: productId as number, options }),
      qty: count,
      ...(note.trim() ? { note: note.trim() } : {}),
    });
  };

  // A read that failed: an alert with its retry; one that failed again over an answer: a note.
  // Nothing is «being read» then (final review M3) — the limit and the position wait unnamed.
  const readQuery = item ? detail : groupsReady ? lookup : undefined;
  const readFailed = readQuery != null && readQuery.isError && !readQuery.isFetching;

  let limitText: string;
  if (!countValid) limitText = t('stock.move.qtyInvalid');
  else if (shownCan == null) limitText = readFailed ? '' : t('stock.move.reading');
  else if (shownOver) limitText = t('stock.move.overLimit', { n: shownCan });
  else limitText = t('stock.assemble.upTo', { n: shownCan });

  const readNote =
    readQuery && readQuery.isError && !readQuery.isFetching ? (
      // Over numbers on screen a refresh failed; over none, nothing was read (Codex V05).
      shown ? (
        <RefreshFailedNote onRetry={() => readQuery.refetch()} />
      ) : (
        <LoadFailedNote
          message={t(item ? 'stock.move.positionFailed' : 'stock.move.lookupFailed')}
          onRetry={() => readQuery.refetch()}
        />
      )
    ) : null;

  const targetLabel = (code: string, configuration: LineConfiguration) =>
    [code, lineConfigLabel(configuration, 'product', t)].filter(Boolean).join(' · ');

  return (
    <WorkshopDialog
      size="md"
      onClose={close}
      title={t('stock.assemble.title')}
      subtitle={t('stock.assemble.subtitle')}
      pending={pending}
      error={assemble.isError ? (assemble.error as Error).message : undefined}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={close} disabled={pending}>
            {t('common.cancel')}
          </Button>
          <Button
            id={submitId}
            type="submit"
            form={ids.form}
            disabled={!canSubmit}
            aria-describedby={why ? why.id : undefined}
            data-testid="assemble-submit"
          >
            {pending && <Loader2 className="w-4 h-4 animate-spin" />}
            {t('stock.assemble.submit')}
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
          {item != null && (
            // The position's product, fixed (R01) — named from the row before anything is read
            // (final review I1), as the move dialog names it in its subtitle.
            <div className="col-span-full flex min-w-0 flex-col gap-1" data-testid="assemble-product">
              <p className="text-sm text-bambu-gray-light">{t('stock.move.product')}</p>
              <p className="text-sm text-white">
                {[item.product.name, item.code, lineConfigLabel(item.configuration, 'product', t)].filter(Boolean).join(' · ')}
              </p>
            </div>
          )}
          {item == null && (
            <StockProductChoice
              productId={productId}
              onProduct={setProductId}
              choices={choices}
              onChoices={setChoices}
              disabled={pending}
              productLocked={forProduct != null}
              productInputId={ids.product}
            />
          )}
          <WorkshopField
            label={t('stock.assemble.qty')}
            htmlFor={ids.qty}
            hint={
              <span
                data-testid="assemble-limit"
                data-stale={(stale && shownCan != null) || undefined}
                className={`${shownOver || !countValid ? 'text-status-warning' : ''} ${stale ? 'opacity-60' : ''}`.trim() || undefined}
              >
                {limitText}
              </span>
            }
          >
            <input
              id={ids.qty}
              type="number"
              min={1}
              max={shownCan || undefined}
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              aria-describedby={`${ids.qty}-hint`}
              aria-invalid={over || !countValid || undefined}
              className={`${FIELD_CLASS} tabular-nums`}
            />
          </WorkshopField>
          <WorkshopField label={t('stock.assemble.note')} htmlFor={ids.note} full>
            <input
              id={ids.note}
              type="text"
              maxLength={NOTE_MAX}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className={FIELD_CLASS}
            />
          </WorkshopField>
          {!(target === undefined && readFailed) && (
            <p
              data-testid="assemble-position"
              data-stale={stale || undefined}
              className={`col-span-full rounded-lg bg-bambu-dark px-3 py-2 text-sm text-bambu-gray-light ${stale ? 'opacity-60' : ''}`}
            >
              {target === undefined
                ? t('stock.move.reading')
                : target === null
                  ? t('stock.assemble.newPosition')
                  : t('stock.assemble.position', { label: targetLabel(target.code, target.configuration), n: target.onHand })}
            </p>
          )}
          {readNote && <div className="col-span-full">{readNote}</div>}
        </WorkshopFormGrid>

        {shown &&
          (parts.length === 0 ? (
            <p className="mb-2 text-sm text-bambu-gray">{t('stock.assemble.noParts')}</p>
          ) : (
            <table
              data-testid="assemble-parts"
              data-stale={stale || undefined}
              aria-busy={stale || undefined}
              className={`mb-2 w-full text-sm ${stale ? 'opacity-60' : ''}`}
            >
              <thead>
                <tr className="text-xs text-bambu-gray text-left">
                  <th className="font-normal p-1">{t('stock.part')}</th>
                  <th className="font-normal p-1 text-right">{t('stock.perUnit')}</th>
                  <th className="font-normal p-1 text-right">{t('stock.balance')}</th>
                  <th className="font-normal p-1 text-right">{t('stock.assemble.writeOff')}</th>
                </tr>
              </thead>
              <tbody>
                {parts.map((p) => {
                  const need = countValid ? p.per * count : 0;
                  const short = need > p.on_shelf ? need - p.on_shelf : 0;
                  return (
                    <tr key={p.part_id} className="text-white align-top" data-testid={`assemble-part-${p.part_id}`}>
                      <td className="p-1">{p.name}</td>
                      <td className="p-1 text-right tabular-nums">{`× ${p.per}`}</td>
                      <td
                        className={`p-1 text-right tabular-nums ${short > 0 ? 'text-status-warning' : ''}`}
                        data-testid={`assemble-shelf-${p.part_id}`}
                      >
                        {p.on_shelf}
                      </td>
                      <td className="p-1 text-right tabular-nums" data-testid={`assemble-writeoff-${p.part_id}`}>
                        {need}
                        {short > 0 && (
                          <small className="block text-xs text-status-warning">{t('stock.assemble.short', { n: short })}</small>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ))}

        {why && why.id === ids.why && (
          <p id={ids.why} className="mb-2 text-sm text-status-warning">
            {why.text}
          </p>
        )}
        <p className="text-xs text-bambu-gray">{t('stock.assemble.boughtHint')}</p>
      </form>
    </WorkshopDialog>
  );
}
