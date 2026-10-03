import { useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { api, STOCK_MAX_QTY as MAX_QTY, WAYBILL_MAX } from '../../api/client';
import type { CustomerContact, FulfilmentRecipient, StockItem, StockMoveBody, StockMoveKind } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { useStockItem, useStockLookup } from '../../hooks/useFinishedStock';
import { useProductDetail } from '../../hooks/useProductDetail';
import { invalidateStock } from '../../utils/queryInvalidation';
import { Button } from '../Button';
import { CustomerPicker } from '../pickers/CustomerPicker';
import { RecipientFields } from '../projects/fulfilment/RecipientFields';
import { lineConfigLabel } from '../projects/lineConfigLabel';
import { signed } from '../products/stockMovementHelpers';
import { LoadFailedNote } from '../workshop/LoadFailedNote';
import { RefreshFailedNote } from '../workshop/RefreshFailedNote';
import { WorkshopDialog } from '../workshop/WorkshopDialog';
import { WorkshopField, WorkshopFormGrid } from '../workshop/WorkshopFormGrid';
import { DispatchNoteCreated } from './DispatchNoteCreated';
import { StockLookupNote, StockPositionHeader, StockProductChoice } from './StockProductChoice';

const FIELD_CLASS =
  'w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:border-bambu-green focus:outline-none';
const NOTE_MAX = 500;

/** A contact as the recipient an issue starts from (spec workshop-order-issue, rule 16). */
function recipientOf(contact: CustomerContact | undefined): FulfilmentRecipient {
  return {
    name: contact?.name ?? null,
    phone: contact?.phone ?? null,
    delivery_method: contact?.delivery_method_name ?? null,
    delivery_details: contact?.delivery_details ?? null,
  };
}

/**
 * The CURRENT answer of a query (G08): a success of THIS key that arrived after the dialog
 * opened, with no read on its way. A cached answer from before, a placeholder of another
 * key or an answer being read again is not one.
 */
function isCurrent(q: UseQueryResult<unknown>): boolean {
  return q.isSuccess && q.isFetchedAfterMount && !q.isFetching && !q.isPlaceholderData;
}

/** A reason the primary waits, and the element that says it. */
interface Why {
  text: string;
  id: string;
}

/**
 * «Рух готових» — one movement of a finished-goods position (spec workshop-finished-goods,
 * rule 26; WS-13 E12 G): receipt, stocktake, reserve, release or issue, in the Workshop
 * dialog.
 *
 * Opened from a position, the configuration is fixed; from the page header or a product,
 * the operator names the configuration and the server answers which position that is
 * (`lookup`). ⚠️ **Every number is a CURRENT read's** (G08 / R04): the dialog reads the
 * position (and the lookup) itself at the opening — the app keeps a query fresh for a
 * minute, so a cached position is not an answer — and only an answer of the current key
 * that arrived after the opening, with nothing on its way, gives a figure, a limit, «no
 * position» or K. A row's own numbers are names' company, never a limit.
 *
 * The limit is named where it applies (R03): a reservation and a plain issue — the
 * available count; a release and an issue «from the manual reservation» — the manual
 * reservation alone (an order's reservation never counts, and the two modes never add up).
 * A refusal stays in the dialog's slot in the system's language, the focus goes to the
 * primary, the draft stays whole, and the position or the lookup is read again — a re-read
 * changes numbers and limits, never what was typed.
 */
export function StockMoveDialog({
  kind,
  item,
  productId: forProduct,
  onClose,
}: {
  kind: StockMoveKind;
  item?: StockItem;
  /** Opened for one product (the product page's «Receipt», WS-13 E9 F01): the product is
   *  named, its configuration is chosen here. */
  productId?: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const uid = useId();
  const ids = {
    form: `${uid}-form`,
    product: `${uid}-product`,
    qty: `${uid}-qty`,
    counted: `${uid}-counted`,
    note: `${uid}-note`,
    customer: `${uid}-customer`,
    waybill: `${uid}-waybill`,
    why: `${uid}-why`,
    noPosition: `${uid}-no-position`,
  };

  const [productId, setProductId] = useState<number | null>(forProduct ?? null);
  const [choices, setChoices] = useState<Record<number, number>>({});
  const [qty, setQty] = useState('1');
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [fromReserve, setFromReserve] = useState(false);
  const [waybill, setWaybill] = useState('');
  // The recipient starts as the customer's main contact; an edit belongs to the customer it
  // was made for, so picking another customer starts from THAT one's contact again.
  const [recipientEdit, setRecipientEdit] = useState<{ customerId: number; value: FulfilmentRecipient } | null>(null);
  // After a refusal the position (or the lookup) is read again; until it answers nothing is judged.
  const [rereading, setRereading] = useState(false);

  // ---- which position: fixed, or the server's answer for a configuration (G02)
  const product = useProductDetail(item ? null : productId);
  // The groups must be read before a configuration means anything (G08).
  const groupsReady = item == null && productId != null && product.data != null;
  const options = Object.values(choices);
  const lookup = useStockLookup(groupsReady ? productId : null, options);
  const lookupKey = `${groupsReady ? productId : ''}:${[...options].sort((a, b) => a - b).join(',')}`;
  useEffect(() => {
    // Every new key is read now — a cached answer of the same key is not this dialog's.
    if (groupsReady) void lookup.refetch({ cancelRefetch: false });
    // The key is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookupKey]);
  const lookupCurrent = groupsReady && isCurrent(lookup) && !rereading;
  const lookupOwn = lookup.data && !lookup.isPlaceholderData ? lookup.data : undefined;

  const positionId = item?.id ?? lookupOwn?.item?.id;
  const detail = useStockItem(positionId ?? 0);
  useEffect(() => {
    if (positionId != null) void detail.refetch({ cancelRefetch: false });
    // The position is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positionId]);
  const detailCurrent = positionId != null && isCurrent(detail) && !rereading;
  const figures = detailCurrent ? detail.data : undefined;
  // A failed re-read keeps the old numbers on screen beside its note — never as a limit.
  const shownFigures = figures ?? (detail.isError && !detail.isFetching ? detail.data : undefined);
  const manual = figures
    ? figures.reservations.filter((r) => r.project_id == null).reduce((sum, r) => sum + r.qty, 0)
    : undefined;

  // ---- the customer's contacts, for the recipient (G05, G08)
  const contacts = useQuery({
    queryKey: ['customer-recipient', customerId],
    queryFn: () => api.getCustomer(customerId as number),
    enabled: kind === 'issue' && customerId != null,
    retry: false,
  });
  const recipient =
    recipientEdit && recipientEdit.customerId === customerId
      ? recipientEdit.value
      : recipientOf(contacts.data?.id === customerId ? contacts.data?.contacts[0] : undefined);

  // ---- the amount
  const qtyValue = Number(qty);
  const qtyValid = qty.trim() !== '' && Number.isInteger(qtyValue) && qtyValue >= 1 && qtyValue <= MAX_QTY;
  const countedValue = Number(counted);
  const countedValid =
    counted.trim() !== '' && Number.isInteger(countedValue) && countedValue >= 0 && countedValue <= MAX_QTY;
  const amountValid = kind === 'stocktake' ? countedValid : qtyValid;

  const noPosition = item == null && lookupCurrent && lookupOwn != null && lookupOwn.item == null;
  // A count of 0 of a configuration with no position would move nothing, and the server
  // creates nothing for it — so it is not offered.
  const createsHere = kind === 'receipt' || (kind === 'stocktake' && countedValid && countedValue > 0);

  // The active limit (R03): `null` — this kind has none; `undefined` — not read yet.
  let limitValue: number | null | undefined = null;
  if (kind === 'reserve') limitValue = figures?.available;
  else if (kind === 'release') limitValue = manual;
  else if (kind === 'issue') limitValue = fromReserve ? manual : figures?.available;
  const limitKey = kind === 'issue' && fromReserve ? 'issueReserve' : kind;
  const over = limitValue != null && qtyValid && qtyValue > limitValue;

  // A stocktake against the current read (G04).
  const lowerCount = figures != null && countedValid && countedValue < figures.on_hand;
  const belowReserve = figures != null && countedValid && countedValue < figures.reserved;
  const noteMissing = lowerCount && note.trim() === '';
  const diff = kind === 'stocktake' && countedValid ? (figures ? countedValue - figures.on_hand : noPosition ? countedValue : null) : null;

  // Nothing can be judged until the reads it needs are current.
  const readsReady =
    kind === 'receipt'
      ? item != null || lookupCurrent
      : kind === 'stocktake'
        ? item != null
          ? detailCurrent
          : lookupCurrent && (lookupOwn?.item == null || detailCurrent)
        : limitValue !== undefined;

  // The first reason the primary waits, named where it is said.
  let why: Why | null = null;
  if (noPosition && !createsHere && kind !== 'stocktake') why = { text: t('stock.move.noPosition'), id: ids.noPosition };
  else if (kind === 'issue' && customerId == null) why = { text: t('stock.move.customerRequired'), id: ids.why };
  else if (kind === 'issue' && fromReserve && manual === 0) why = { text: t('stock.move.fromReserveEmpty'), id: ids.why };
  else if (kind !== 'stocktake' && !qtyValid) why = { text: t('stock.move.qtyInvalid'), id: `${ids.qty}-hint` };
  else if (over) why = { text: t('stock.move.overLimit', { n: limitValue }), id: `${ids.qty}-hint` };
  else if (kind === 'stocktake' && belowReserve) why = { text: t('stock.move.belowReserve', { n: figures?.reserved }), id: ids.why };
  else if (kind === 'stocktake' && noteMissing) why = { text: t('stock.move.noteRequired'), id: `${ids.note}-hint` };

  // ⚠️ Synchronous: one press, one request; nothing closes the dialog under it.
  const sent = useRef(false);
  // An issue made a dispatch note: say so, with a way to open it (spec workshop-dispatch-notes, rule 24).
  const [created, setCreated] = useState<{ id: number; code: string; units: number | null } | null>(null);
  const move = useMutation({
    mutationFn: (body: StockMoveBody) => api.moveStock(body),
    // The note names the units the request SENT (its variables), never the field: the field
    // stays editable while the issue is on its way (Codex E6-V01).
    onSuccess: (result, body) => {
      invalidateStock(queryClient);
      if (result.issue_id != null && result.issue_code) {
        setCreated({ id: result.issue_id, code: result.issue_code, units: body.qty ?? null });
        return;
      }
      showToast(t(result.moved ? 'stock.move.saved' : 'stock.move.nothingMoved'));
      onClose();
    },
    // The refusal says what the server saw; what the dialog judges against is read again
    // (G07) — the draft is not touched.
    onError: () => {
      sent.current = false;
      invalidateStock(queryClient);
      setRereading(true);
      const reads: Promise<unknown>[] = [];
      if (positionId != null) reads.push(detail.refetch({ cancelRefetch: false }));
      if (item == null && groupsReady) reads.push(lookup.refetch({ cancelRefetch: false }));
      void Promise.allSettled(reads).finally(() => setRereading(false));
    },
  });
  const pending = move.isPending;
  const submitId = `${ids.form}-submit`;
  useEffect(() => {
    if (move.isError) document.getElementById(submitId)?.focus();
  }, [move.isError, move.error, submitId]);

  // The cursor starts in the first field (G07): the product from the header, else the amount.
  useEffect(() => {
    const first = item == null && forProduct == null ? ids.product : kind === 'stocktake' ? ids.counted : ids.qty;
    document.getElementById(first)?.focus();
    // Once, at the opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = () => {
    if (sent.current) return;
    onClose();
  };

  const target = item != null || (lookupCurrent && (lookupOwn?.item != null || createsHere));
  const canSubmit = !pending && target && amountValid && readsReady && why == null;

  const submit = () => {
    if (sent.current || !canSubmit) return;
    sent.current = true;
    const body: StockMoveBody = {
      kind,
      ...(item ? { item_id: item.id } : { product_id: productId as number, options }),
      ...(kind === 'stocktake' ? { counted: countedValue } : { qty: qtyValue }),
      ...(note.trim() ? { note: note.trim() } : {}),
      ...(kind === 'issue'
        ? {
            ...(customerId != null ? { customer_id: customerId } : {}),
            from_reserve: fromReserve,
            recipient,
            waybill: waybill.trim() || null,
          }
        : {}),
    };
    move.mutate(body);
  };

  if (created)
    return <DispatchNoteCreated id={created.id} code={created.code} units={created.units} fromOrder={false} onClose={onClose} />;

  const caption = item ? lineConfigLabel(item.configuration, 'product', t) : '';
  const subtitle = item
    ? [item.product.name, item.code, caption].filter(Boolean).join(' · ')
    : t('stock.move.subtitle');

  // The limit's line under the quantity: the limit named, «reading…», or why it is too much.
  let limitText: string | undefined;
  if (!qtyValid && kind !== 'stocktake') limitText = t('stock.move.qtyInvalid');
  else if (limitValue === undefined) limitText = t('stock.move.reading');
  else if (limitValue !== null) limitText = over ? t('stock.move.overLimit', { n: limitValue }) : t(`stock.move.limit.${limitKey}`, { n: limitValue });
  const showFromReserve = kind === 'issue' && ((manual ?? 0) > 0 || fromReserve);
  const positionNotes =
    positionId != null && detail.isError && !detail.isFetching ? (
      detail.data ? (
        <RefreshFailedNote onRetry={() => detail.refetch()} />
      ) : (
        <LoadFailedNote message={t('stock.move.positionFailed')} onRetry={() => detail.refetch()} />
      )
    ) : null;

  return (
    <WorkshopDialog
      size="md"
      onClose={close}
      title={t(`stock.move.title.${kind}`)}
      subtitle={subtitle}
      pending={pending}
      error={move.isError ? (move.error as Error).message : undefined}
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
            data-testid="stock-move-submit"
          >
            {pending && <Loader2 className="w-4 h-4 animate-spin" />}
            {t(`stock.move.primary.${kind}`)}
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
          {item ? (
            <div className="col-span-full space-y-2" data-testid="stock-move-position">
              <StockPositionHeader item={item} figures={shownFigures ?? null} />
              {positionNotes}
            </div>
          ) : (
            <>
              <StockProductChoice
                productId={productId}
                onProduct={setProductId}
                choices={choices}
                onChoices={setChoices}
                disabled={pending}
                productLocked={forProduct != null}
                productInputId={ids.product}
              />
              {groupsReady &&
                (lookup.isError && !lookup.isFetching && !lookupOwn ? (
                  <div className="col-span-full">
                    <LoadFailedNote message={t('stock.move.lookupFailed')} onRetry={() => lookup.refetch()} />
                  </div>
                ) : (
                  <>
                    <StockLookupNote
                      lookup={lookupOwn}
                      creates={kind === 'receipt' || kind === 'stocktake'}
                      reading={!lookupCurrent && !(lookup.isError && lookupOwn)}
                      noPositionId={ids.noPosition}
                    />
                    {lookup.isError && lookupOwn && !lookup.isFetching && (
                      <div className="col-span-full">
                        <RefreshFailedNote onRetry={() => lookup.refetch()} />
                      </div>
                    )}
                  </>
                ))}
              {positionNotes && (
                <div className="col-span-full" data-testid="stock-move-position">
                  {positionNotes}
                </div>
              )}
            </>
          )}

          {kind === 'stocktake' ? (
            <WorkshopField
              label={t('stock.move.counted')}
              htmlFor={ids.counted}
              hint={
                <span className="space-x-2">
                  {shownFigures && (
                    <span>{t('stock.move.now', { onHand: shownFigures.on_hand, reserved: shownFigures.reserved })}</span>
                  )}
                  {diff != null && (
                    <span>
                      {t('stock.move.difference')}{' '}
                      <span className={diff > 0 ? 'text-bambu-green' : diff < 0 ? 'text-status-warning' : ''}>
                        {diff === 0 ? t('stock.move.noChange') : signed(diff)}
                      </span>
                    </span>
                  )}
                </span>
              }
            >
              <input
                id={ids.counted}
                type="number"
                min={0}
                max={MAX_QTY}
                value={counted}
                onChange={(e) => setCounted(e.target.value)}
                aria-describedby={`${ids.counted}-hint`}
                className={`${FIELD_CLASS} tabular-nums`}
              />
            </WorkshopField>
          ) : (
            <WorkshopField
              label={t('stock.move.qty')}
              htmlFor={ids.qty}
              hint={
                limitText !== undefined ? (
                  <span data-testid="stock-move-limit" className={over || !qtyValid ? 'text-status-warning' : undefined}>
                    {limitText}
                  </span>
                ) : undefined
              }
            >
              <input
                id={ids.qty}
                type="number"
                min={1}
                max={MAX_QTY}
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                aria-describedby={limitText !== undefined ? `${ids.qty}-hint` : undefined}
                aria-invalid={over || !qtyValid || undefined}
                className={`${FIELD_CLASS} tabular-nums`}
              />
            </WorkshopField>
          )}

          {kind === 'issue' && (
            <>
              <WorkshopField label={t('stock.move.customer')} htmlFor={ids.customer} full>
                <CustomerPicker id={ids.customer} value={customerId} onChange={setCustomerId} />
              </WorkshopField>
              {customerId != null && (contacts.isPending || contacts.isError) && (
                <div data-testid="stock-move-contacts" className="col-span-full flex items-center gap-2 text-xs text-bambu-gray">
                  {contacts.isError ? (
                    <>
                      <span>{t('stock.move.contactsFailed')}</span>
                      <Button size="sm" variant="ghost" onClick={() => contacts.refetch()}>
                        {t('common.retry')}
                      </Button>
                    </>
                  ) : (
                    <span role="status">{t('stock.move.contactsReading')}</span>
                  )}
                </div>
              )}
              {customerId != null && (
                <RecipientFields value={recipient} onChange={(value) => setRecipientEdit({ customerId, value })} />
              )}
              <WorkshopField label={t('orders.fulfil.waybill')} htmlFor={ids.waybill}>
                <input
                  id={ids.waybill}
                  value={waybill}
                  maxLength={WAYBILL_MAX}
                  onChange={(e) => setWaybill(e.target.value)}
                  className={FIELD_CLASS}
                />
              </WorkshopField>
              {showFromReserve && (
                <label className="col-span-full flex items-center gap-2 text-sm text-bambu-gray-light">
                  <input
                    type="checkbox"
                    checked={fromReserve}
                    onChange={(e) => setFromReserve(e.target.checked)}
                  />
                  {t('stock.move.fromReserve')}
                </label>
              )}
            </>
          )}

          <WorkshopField
            label={t('stock.move.note')}
            htmlFor={ids.note}
            hint={noteMissing ? <span className="text-status-warning">{t('stock.move.noteRequired')}</span> : undefined}
            full
          >
            <input
              id={ids.note}
              type="text"
              maxLength={NOTE_MAX}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={
                kind === 'receipt' || kind === 'issue'
                  ? t(`stock.move.placeholder.${kind}`)
                  : kind === 'stocktake'
                    ? t('stock.move.stocktakeNoteHint')
                    : undefined
              }
              aria-describedby={noteMissing ? `${ids.note}-hint` : undefined}
              className={FIELD_CLASS}
            />
          </WorkshopField>
        </WorkshopFormGrid>

        {why && why.id === ids.why && (
          <p id={ids.why} className="mb-2 text-sm text-status-warning">
            {why.text}
          </p>
        )}
        <p className="text-xs text-bambu-gray">{t(`stock.move.hint.${kind}`)}</p>
      </form>
    </WorkshopDialog>
  );
}
