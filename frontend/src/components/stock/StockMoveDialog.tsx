import { useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { api, STOCK_MAX_QTY as MAX_QTY, WAYBILL_MAX } from '../../api/client';
import type { CustomerContact, FulfilmentRecipient, StockItem, StockMoveBody, StockMoveKind } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
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
import { manualReserved } from './manualReservation';
import { useStockTarget } from './useStockTarget';

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

/** A reason the primary waits, the element that says it and the field that answers it. */
interface Why {
  text: string;
  id: string;
  focus?: string;
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
 * A refusal stays in the dialog's slot in the system's language, the draft stays whole, and
 * the position or the lookup is read again — a re-read changes numbers and limits, never what
 * was typed. Once it has answered, the focus goes to the primary when it can act, else to the
 * field that says why (a disabled button cannot hold the focus: it fell to the page — E12
 * pilot).
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
    fromReserve: `${uid}-from-reserve`,
    countedInvalid: `${uid}-counted-invalid`,
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

  // ---- which position: fixed, or the server's answer for a configuration (G02, G08)
  const options = Object.values(choices);
  const { groupsReady, lookup, lookupCurrent, lookupOwn, positionId, detail, detailCurrent, figures, shownFigures, reread, rereading } =
    useStockTarget({ item, productId, options });
  const manual = figures ? manualReserved(figures.reservations) : undefined;

  // ---- the customer's contacts, for the recipient (G05, G08)
  const contacts = useQuery({
    queryKey: ['customer-recipient', customerId],
    queryFn: () => api.getCustomer(customerId as number),
    enabled: kind === 'issue' && customerId != null,
    retry: false,
  });
  // Each pick is read now (G08): a customer read a minute ago is not this pick's answer.
  useEffect(() => {
    if (kind === 'issue' && customerId != null) void contacts.refetch({ cancelRefetch: false });
    // The customer is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);
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
  // An empty count is only not typed yet; a typed one that is no count says why (final review M8).
  const countedTyped = counted.trim() !== '';

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
  else if (kind === 'issue' && customerId == null) why = { text: t('stock.move.customerRequired'), id: ids.why, focus: ids.customer };
  else if (kind === 'issue' && fromReserve && manual === 0) why = { text: t('stock.move.fromReserveEmpty'), id: ids.why, focus: ids.fromReserve };
  else if (kind !== 'stocktake' && !qtyValid) why = { text: t('stock.move.qtyInvalid'), id: `${ids.qty}-hint`, focus: ids.qty };
  else if (over) why = { text: t('stock.move.overLimit', { n: limitValue }), id: `${ids.qty}-hint`, focus: ids.qty };
  else if (kind === 'stocktake' && countedTyped && !countedValid)
    why = { text: t('stock.move.countedInvalid'), id: ids.countedInvalid, focus: ids.counted };
  else if (kind === 'stocktake' && belowReserve) why = { text: t('stock.move.belowReserve', { n: figures?.reserved }), id: ids.why, focus: ids.counted };
  else if (kind === 'stocktake' && noteMissing) why = { text: t('stock.move.noteRequired'), id: `${ids.note}-hint`, focus: ids.note };

  // ⚠️ Synchronous: one press, one request; nothing closes the dialog under it.
  const sent = useRef(false);
  // A refusal hands the focus back once the re-read has answered (below).
  const refocus = useRef(false);
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
      refocus.current = true;
      invalidateStock(queryClient);
      reread();
    },
  });
  const pending = move.isPending;
  const submitId = `${ids.form}-submit`;

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

  // After a refusal: once the re-read has answered, the primary when it can act, else the field
  // that says why — the amount when nothing names one.
  useEffect(() => {
    if (!refocus.current || rereading || pending) return;
    refocus.current = false;
    // A focus the operator placed meanwhile is theirs (final review I2): only a lost one — on
    // the page, or still on the primary that went grey — is given back.
    const active = document.activeElement;
    if (active && active !== document.body && active.id !== submitId) return;
    const to = canSubmit ? submitId : (why?.focus ?? (kind === 'stocktake' ? ids.counted : ids.qty));
    document.getElementById(to)?.focus();
  });

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
  // A read that failed is said by its note, with a retry; nothing is «being read» then (final
  // review M3) — so no limit is named until a read answers.
  const readFailed =
    (positionId != null && detail.isError && !detail.isFetching) ||
    (item == null && groupsReady && lookup.isError && !lookup.isFetching);
  let limitText: string | undefined;
  if (!qtyValid && kind !== 'stocktake') limitText = t('stock.move.qtyInvalid');
  else if (limitValue === undefined) limitText = readFailed ? undefined : t('stock.move.reading');
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
                  {countedTyped && !countedValid && (
                    <span id={ids.countedInvalid} className="text-status-warning">
                      {t('stock.move.countedInvalid')}
                    </span>
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
              {customerId != null && (!contacts.isFetchedAfterMount || contacts.isError) && (
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
                    id={ids.fromReserve}
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
