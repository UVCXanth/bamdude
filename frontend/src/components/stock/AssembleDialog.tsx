import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import type { StockAssembleBody, StockItem } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { useStockItem, useStockLookup } from '../../hooks/useFinishedStock';
import { invalidateStock } from '../../utils/queryInvalidation';
import { Button } from '../Button';
import { Modal } from '../Modal';
import { StockLookupNote, StockPositionHeader, StockProductChoice } from './StockProductChoice';

const FIELD_CLASS =
  'w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:border-bambu-green focus:outline-none';

/**
 * «Зібрати з деталей» (spec workshop-finished-goods, rules 10, 26): the kit's
 * printed parts leave the free shelf and the position grows.
 *
 * The kit, the shelf and «can assemble» are the server's — from the position
 * page's detail when opened from a position, from `lookup` when a product and
 * its options were picked. A part whose shelf is short of `per × how many` is
 * marked; the server refuses more than it can make, and the button does not
 * offer it. Purchased parts are not on a shelf and are not written off.
 */
export function AssembleDialog({ item, onClose }: { item?: StockItem; onClose: () => void }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();

  const [productId, setProductId] = useState<number | null>(null);
  const [choices, setChoices] = useState<Record<number, number>>({});
  const [qty, setQty] = useState('1');
  const [note, setNote] = useState('');

  const options = Object.values(choices);
  const { data: detail } = useStockItem(item?.id ?? 0);
  const { data: lookup } = useStockLookup(item ? null : productId, options);
  const source = item ? detail : productId != null ? lookup : undefined;
  const parts = source?.parts ?? [];
  const canAssemble = source?.can_assemble ?? 0;

  const assemble = useMutation({
    mutationFn: (body: StockAssembleBody) => api.assembleStock(body),
    onSuccess: () => {
      invalidateStock(queryClient);
      showToast(t('stock.assemble.done'));
      onClose();
    },
    onError: (e: Error) => {
      showToast(e.message, 'error');
      invalidateStock(queryClient);
    },
  });

  const count = Number(qty);
  const valid = Number.isInteger(count) && count >= 1 && count <= canAssemble;

  const submit = () =>
    assemble.mutate({
      ...(item ? { item_id: item.id } : { product_id: productId as number, options }),
      qty: count,
      ...(note.trim() ? { note: note.trim() } : {}),
    });

  return (
    <Modal onClose={onClose} title={t('stock.assemble.title')} size="md">
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
              disabled={assemble.isPending}
            />
            <StockLookupNote lookup={productId != null ? lookup : undefined} creates />
          </>
        )}

        {source && (
          <>
            {parts.length === 0 ? (
              <p className="text-sm text-bambu-gray">{t('stock.assemble.noParts')}</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-bambu-gray text-left">
                    <th className="font-normal p-1">{t('stock.part')}</th>
                    <th className="font-normal p-1 text-right">{t('stock.perUnit')}</th>
                    <th className="font-normal p-1 text-right">{t('stock.balance')}</th>
                  </tr>
                </thead>
                <tbody>
                  {parts.map((p) => {
                    const short = Number.isInteger(count) && count > 0 && p.on_shelf < p.per * count;
                    return (
                      <tr key={p.part_id} className="text-white" data-testid={`assemble-part-${p.part_id}`}>
                        <td className="p-1">{p.name}</td>
                        <td className="p-1 text-right tabular-nums">{p.per}</td>
                        <td
                          className={`p-1 text-right tabular-nums ${short ? 'text-status-warning' : ''}`}
                          data-testid={`assemble-shelf-${p.part_id}`}
                        >
                          {p.on_shelf}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            <p className="text-xs text-bambu-gray">{t('stock.assemble.boughtHint')}</p>
          </>
        )}

        <div>
          <label htmlFor="stock-assemble-qty" className="block text-sm text-bambu-gray mb-1">
            {t('stock.assemble.qty')}
          </label>
          <div className="flex items-center gap-3">
            <input
              id="stock-assemble-qty"
              type="number"
              min={1}
              max={canAssemble || undefined}
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              className={FIELD_CLASS}
            />
            <span className="text-sm text-bambu-gray whitespace-nowrap">{t('stock.assemble.upTo', { n: canAssemble })}</span>
          </div>
        </div>

        <div>
          <label htmlFor="stock-assemble-note" className="block text-sm text-bambu-gray mb-1">
            {t('stock.move.note')}
          </label>
          <input
            id="stock-assemble-note"
            type="text"
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
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
          disabled={!valid || assemble.isPending}
          className="flex-1"
          data-testid="assemble-submit"
        >
          {t('stock.assemble.submit')}
        </Button>
      </div>
    </Modal>
  );
}
