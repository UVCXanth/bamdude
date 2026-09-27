import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../../api/client';
import type { BatchLine, BatchLinesResult } from '../../../api/client';
import { useToast } from '../../../contexts/ToastContext';
import { useSearchBox } from '../../../hooks/useSearchBox';
import { useStockSuggest } from '../../../hooks/useStockSuggest';
import { invalidateOrderViews, invalidateStock } from '../../../utils/queryInvalidation';
import { Button } from '../../Button';
import { Modal } from '../../Modal';
import { Select } from '../../Select';
import { ProductsTab } from './ProductsTab';
import { newProductPick, productLines, productUnits, shortfalls, suggestItems } from './addToOrderState';
import type { ProductPicks } from './addToOrderState';

type Tab = 'products' | 'parts' | 'plate';
const TABS: Tab[] = ['products', 'parts', 'plate'];
const ORDER_PAGE = 20;

/**
 * «Add to order» (spec workshop-add-to-order, rules 19–25): products, parts of
 * a product and a one-off plate, picked across searches, pages and tabs, and
 * added in ONE batch — one transaction on the server, so a refused line adds
 * nothing.
 *
 * Opened from an order card it adds to that order (`orderId`); opened from a
 * product page it asks which ACTIVE order first. `orderActive` is false for a
 * completed or cancelled order, which takes nothing from stock (rule 7).
 */
export function AddToOrderDialog({
  orderId,
  orderActive = true,
  preselectProductId,
  onClose,
  onAdded,
}: {
  orderId?: number;
  orderActive?: boolean;
  preselectProductId?: number;
  onClose: () => void;
  onAdded?: (result: BatchLinesResult) => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { showToast } = useToast();
  const [tab, setTab] = useState<Tab>('products');
  const [chosenOrder, setChosenOrder] = useState<number | null>(null);
  const [products, setProducts] = useState<ProductPicks>(() =>
    preselectProductId != null ? new Map([[preselectProductId, newProductPick()]]) : new Map(),
  );

  const targetId = orderId ?? chosenOrder;
  // A chosen order came from the active list; a given one says what it is.
  const takesStock = orderId != null ? orderActive : true;
  const items = useMemo(() => suggestItems(products), [products]);
  const { byProduct } = useStockSuggest(items, takesStock);

  const lines: BatchLine[] = productLines(products, byProduct, takesStock);

  const add = useMutation({
    mutationFn: (id: number) => api.addOrderLines(id, lines),
    onSuccess: (result, id) => {
      invalidateOrderViews(qc, { orderId: id });
      invalidateStock(qc);
      showToast(t('orders.add.added', { count: result.results.length }));
      const short = shortfalls(result);
      if (short.length > 0) {
        const detail = short
          .map((s) =>
            t('orders.add.clampedLine', {
              name: s.name,
              gotFinished: s.gotFinished,
              askedFinished: s.askedFinished,
              gotKits: s.gotKits,
              askedKits: s.askedKits,
            }),
          )
          .join('; ');
        showToast(t('orders.add.clamped', { detail }), 'warning');
      }
      onAdded?.(result);
      onClose();
    },
    // The server's sentence, and the dialog stays with every pick in it.
    onError: (err: Error) => showToast(err.message, 'error'),
  });

  const units = productUnits(products);
  const canSubmit = targetId != null && lines.length > 0 && !add.isPending;

  return (
    <Modal
      onClose={onClose}
      title={t('orders.add.title')}
      size="6xl"
      footer={
        <>
          <span className="mr-auto text-sm text-bambu-gray">
            {products.size > 0 && t('orders.add.summary.products', { count: products.size, units })}
          </span>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => targetId != null && add.mutate(targetId)} disabled={!canSubmit}>
            {t('orders.add.submit.products', { count: lines.length })}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {orderId == null && <OrderChoice value={chosenOrder} onChange={setChosenOrder} />}
        <div role="tablist" className="flex gap-1 border-b border-bambu-dark-tertiary">
          {TABS.map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={`px-4 py-2 text-sm border-b-2 -mb-px transition-colors ${
                tab === key ? 'border-bambu-green text-white' : 'border-transparent text-bambu-gray hover:text-white'
              }`}
            >
              {t(`orders.add.tabs.${key}`)}
            </button>
          ))}
        </div>
        <div role="tabpanel">
          {tab === 'products' && (
            <ProductsTab picks={products} onPicksChange={setProducts} takesStock={takesStock} suggestions={byProduct} />
          )}
        </div>
      </div>
    </Modal>
  );
}

/** Which active order to add to — a server search, one page of 20 (spec rule 25). */
function OrderChoice({ value, onChange }: { value: number | null; onChange: (id: number | null) => void }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const setQuery = useCallback((next: string) => setQ(next), []);
  const { typed, setTyped } = useSearchBox(q, setQuery);
  // The chosen order's label, kept for when a new search no longer lists it.
  const [chosenLabel, setChosenLabel] = useState('');
  const params = { status: 'active' as const, ...(q ? { q } : {}), page: 1, per_page: ORDER_PAGE };
  const { data } = useQuery({
    queryKey: ['orders', 'add-to-order', params],
    queryFn: () => api.getOrdersPaged(params),
  });
  const orders = data?.items ?? [];
  const label = (o: { code: string; name: string }) => `${o.code} — ${o.name}`;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        type="search"
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        placeholder={t('orders.add.findOrder')}
        aria-label={t('orders.add.findOrder')}
        className="px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:border-bambu-green focus:outline-none"
      />
      <Select
        aria-label={t('orders.add.order')}
        value={value == null ? '' : String(value)}
        onChange={(e) => {
          const id = e.target.value ? Number(e.target.value) : null;
          const order = orders.find((o) => o.id === id);
          if (order) setChosenLabel(label(order));
          onChange(id);
        }}
        className="min-w-64"
      >
        <option value="">{t('orders.add.chooseOrder')}</option>
        {/* A chosen order a new search no longer lists still shows as chosen. */}
        {value != null && !orders.some((o) => o.id === value) && <option value={String(value)}>{chosenLabel}</option>}
        {orders.map((o) => (
          <option key={o.id} value={String(o.id)}>
            {label(o)}
          </option>
        ))}
      </Select>
    </div>
  );
}
