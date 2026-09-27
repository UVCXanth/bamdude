import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, STOCK_MAX_QTY as MAX_QTY } from '../../api/client';
import type { StockItem, StockMoveBody, StockMoveKind } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { useStockLookup } from '../../hooks/useFinishedStock';
import { invalidateStock } from '../../utils/queryInvalidation';
import { Button } from '../Button';
import { Modal } from '../Modal';
import { CustomerPicker } from '../pickers/CustomerPicker';
import { signed } from '../products/stockMovementHelpers';
import { StockLookupNote, StockPositionHeader, StockProductChoice } from './StockProductChoice';

const FIELD_CLASS =
  'w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:border-bambu-green focus:outline-none';

/** A receipt and a stocktake create the position when the configuration has none. */
const CREATES: ReadonlySet<StockMoveKind> = new Set(['receipt', 'stocktake']);

/**
 * «Рух складу» — one movement of a finished-goods position (spec
 * workshop-finished-goods, rule 26): receipt, stocktake, reserve, release or
 * issue.
 *
 * Opened from a position, the product and configuration are fixed; opened from
 * the page header, the operator picks a product and an option per group and
 * the server answers which position that is (`lookup`) before anything moves.
 * Every refusal is the server's own sentence, in a toast, with the dialog kept
 * open; success refreshes every stock view through `invalidateStock`.
 */
export function StockMoveDialog({
  kind,
  item,
  onClose,
}: {
  kind: StockMoveKind;
  item?: StockItem;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();

  const [productId, setProductId] = useState<number | null>(null);
  const [choices, setChoices] = useState<Record<number, number>>({});
  const [qty, setQty] = useState('1');
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [fromReserve, setFromReserve] = useState(false);

  const options = Object.values(choices);
  const { data: lookup } = useStockLookup(item ? null : productId, options);
  const position = item ?? lookup?.item ?? null;
  const creates = CREATES.has(kind);

  const move = useMutation({
    mutationFn: (body: StockMoveBody) => api.moveStock(body),
    onSuccess: (result) => {
      invalidateStock(queryClient);
      showToast(t(result.moved ? 'stock.move.saved' : 'stock.move.nothingMoved'));
      onClose();
    },
    // The refusal says what the server saw; what the dialog shows is re-read so
    // the operator decides again against it (spec rule 26).
    onError: (e: Error) => {
      showToast(e.message, 'error');
      invalidateStock(queryClient);
    },
  });

  const qtyValue = Number(qty);
  const countedValue = Number(counted);
  const amountValid =
    kind === 'stocktake'
      ? counted.trim() !== '' && Number.isInteger(countedValue) && countedValue >= 0 && countedValue <= MAX_QTY
      : Number.isInteger(qtyValue) && qtyValue >= 1 && qtyValue <= MAX_QTY;
  // A count of 0 of a configuration with no position would move nothing, and the
  // server creates nothing for it — so it is not offered.
  const createsHere = kind === 'receipt' || (kind === 'stocktake' && amountValid && countedValue > 0);
  const targetValid = item != null || (productId != null && lookup != null && (createsHere || lookup.item != null));
  const diff = kind === 'stocktake' && counted.trim() !== '' ? countedValue - (position?.on_hand ?? 0) : null;

  const submit = () => {
    const body: StockMoveBody = {
      kind,
      ...(item ? { item_id: item.id } : { product_id: productId as number, options }),
      ...(kind === 'stocktake' ? { counted: countedValue } : { qty: qtyValue }),
      ...(note.trim() ? { note: note.trim() } : {}),
      ...(kind === 'issue' ? { ...(customerId != null ? { customer_id: customerId } : {}), from_reserve: fromReserve } : {}),
    };
    move.mutate(body);
  };

  return (
    <Modal onClose={onClose} title={t(`stock.finished.action.${kind}`)} size="md">
      <div className="p-4 space-y-3">
        {item ? (
          <StockPositionHeader item={item} />
        ) : (
          <>
            <StockProductChoice
              productId={productId}
              onProduct={setProductId}
              choices={choices}
              onChoices={setChoices}
              disabled={move.isPending}
            />
            <StockLookupNote lookup={productId != null ? lookup : undefined} creates={creates} />
          </>
        )}

        {kind === 'stocktake' ? (
          <div>
            <label htmlFor="stock-move-counted" className="block text-sm text-bambu-gray mb-1">
              {t('stock.move.counted')}
            </label>
            <input
              id="stock-move-counted"
              type="number"
              min={0}
              max={MAX_QTY}
              value={counted}
              onChange={(e) => setCounted(e.target.value)}
              className={FIELD_CLASS}
            />
            {diff != null && Number.isInteger(diff) && (
              <p className="text-xs text-bambu-gray mt-1">
                {t('stock.move.difference')}{' '}
                <span className={diff > 0 ? 'text-bambu-green' : diff < 0 ? 'text-status-warning' : ''}>
                  {diff === 0 ? t('stock.move.noChange') : signed(diff)}
                </span>
              </p>
            )}
          </div>
        ) : (
          <div>
            <label htmlFor="stock-move-qty" className="block text-sm text-bambu-gray mb-1">
              {t('stock.move.qty')}
            </label>
            <input
              id="stock-move-qty"
              type="number"
              min={1}
              max={MAX_QTY}
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              className={FIELD_CLASS}
            />
          </div>
        )}

        {kind === 'issue' && (
          <>
            <div>
              <label htmlFor="stock-move-customer" className="block text-sm text-bambu-gray mb-1">
                {t('stock.move.customer')}
              </label>
              <CustomerPicker id="stock-move-customer" value={customerId} onChange={setCustomerId} />
            </div>
            <label className="flex items-center gap-2 text-sm text-bambu-gray">
              <input type="checkbox" checked={fromReserve} onChange={(e) => setFromReserve(e.target.checked)} />
              {t('stock.move.fromReserve')}
            </label>
          </>
        )}

        <div>
          <label htmlFor="stock-move-note" className="block text-sm text-bambu-gray mb-1">
            {t('stock.move.note')}
          </label>
          <input
            id="stock-move-note"
            type="text"
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={kind === 'stocktake' ? t('stock.move.stocktakeNoteHint') : undefined}
            className={FIELD_CLASS}
          />
        </div>
      </div>

      <div className="p-4 border-t border-bambu-dark-tertiary flex gap-3">
        <Button type="button" variant="secondary" onClick={onClose} className="flex-1">
          {t('common.cancel')}
        </Button>
        <Button
          type="button"
          onClick={submit}
          disabled={!amountValid || !targetValid || move.isPending}
          className="flex-1"
          data-testid="stock-move-submit"
        >
          {t('stock.move.submit')}
        </Button>
      </div>
    </Modal>
  );
}
