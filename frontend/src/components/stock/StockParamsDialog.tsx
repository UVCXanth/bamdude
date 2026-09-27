import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import type { StockItem } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { invalidateStock } from '../../utils/queryInvalidation';
import { Button } from '../Button';
import { Modal } from '../Modal';
import { StockPositionHeader } from './StockProductChoice';

const FIELD_CLASS =
  'w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:border-bambu-green focus:outline-none';

/**
 * «Комірка й мінімум» — parameters of a position, not stock: nothing moves and
 * the journal records nothing. An emptied location is «not assigned».
 */
export function StockParamsDialog({ item, onClose }: { item: StockItem; onClose: () => void }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [location, setLocation] = useState(item.location ?? '');
  const [minQty, setMinQty] = useState(String(item.min_qty));

  const save = useMutation({
    mutationFn: () => api.updateStockItem(item.id, { location: location.trim() || null, min_qty: Number(minQty) }),
    onSuccess: () => {
      invalidateStock(queryClient);
      showToast(t('stock.params.saved'));
      onClose();
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  const min = Number(minQty);
  const valid = minQty.trim() !== '' && Number.isInteger(min) && min >= 0;

  return (
    <Modal onClose={onClose} title={t('stock.finished.action.params')} size="md">
      <div className="p-4 space-y-3">
        <StockPositionHeader item={item} />
        <div>
          <label htmlFor="stock-params-location" className="block text-sm text-bambu-gray mb-1">
            {t('stock.finished.location')}
          </label>
          <input
            id="stock-params-location"
            type="text"
            maxLength={64}
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder={t('stock.finished.noLocation')}
            className={FIELD_CLASS}
          />
        </div>
        <div>
          <label htmlFor="stock-params-min" className="block text-sm text-bambu-gray mb-1">
            {t('stock.finished.minimum')}
          </label>
          <input
            id="stock-params-min"
            type="number"
            min={0}
            value={minQty}
            onChange={(e) => setMinQty(e.target.value)}
            className={FIELD_CLASS}
          />
          <p className="text-xs text-bambu-gray mt-1">{t('stock.params.minHint')}</p>
        </div>
      </div>

      <div className="p-4 border-t border-bambu-dark-tertiary flex gap-3">
        <Button type="button" variant="secondary" onClick={onClose} className="flex-1">
          {t('common.cancel')}
        </Button>
        <Button
          type="button"
          onClick={() => save.mutate()}
          disabled={!valid || save.isPending}
          className="flex-1"
          data-testid="stock-params-submit"
        >
          {t('stock.params.submit')}
        </Button>
      </div>
    </Modal>
  );
}
