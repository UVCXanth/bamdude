import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../../api/client';
import type { BatchLine, BatchLinesResult } from '../../../api/client';
import { useToast } from '../../../contexts/ToastContext';
import { useSearchBox } from '../../../hooks/useSearchBox';
import { useStockSuggest } from '../../../hooks/useStockSuggest';
import { invalidateOrderViews } from '../../../utils/queryInvalidation';
import { Button } from '../../Button';
import { Modal } from '../../Modal';
import { Select } from '../../Select';
import { PartsTab } from './PartsTab';
import { PlateTab } from './PlateTab';
import { ProductsTab } from './ProductsTab';
import {
  newProductPick,
  partUnits,
  partsLines,
  plateLines,
  productLines,
  productUnits,
  shortfalls,
  suggestItems,
} from './addToOrderState';
import type { PartPicks, PlatePick, ProductPicks } from './addToOrderState';

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
  const [parts, setParts] = useState<PartPicks>(() => new Map());
  const [plate, setPlate] = useState<PlatePick>(null);

  const targetId = orderId ?? chosenOrder;
  // A chosen order came from the active list; a given one says what it is.
  const takesStock = orderId != null ? orderActive : true;
  const items = useMemo(() => suggestItems(products), [products]);
  const { byProduct } = useStockSuggest(items, takesStock);

  // Everything picked on every tab goes in ONE batch — one transaction, so a
  // refused line adds nothing (spec rule 11).
  const productBatch = productLines(products, byProduct, takesStock);
  const partsBatch = partsLines(parts);
  const plateBatch = plateLines(plate);
  const lines: BatchLine[] = [...productBatch, ...partsBatch, ...plateBatch];

  const add = useMutation({
    mutationFn: (id: number) => api.addOrderLines(id, lines),
    onSuccess: (result, id) => {
      // Both shelves' keys are order views (`ORDER_VIEW_KEYS`), each once.
      invalidateOrderViews(qc, { orderId: id });
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

  const canSubmit = targetId != null && lines.length > 0 && !add.isPending;
  const summaries = [
    products.size > 0 && t('orders.add.summary.products', { count: products.size, units: productUnits(products) }),
    parts.size > 0 && t('orders.add.summary.parts', { count: parts.size, units: partUnits(parts) }),
    plateBatch.length > 0 && t('orders.add.summary.plate'),
  ].filter((s): s is string => Boolean(s));
  // One kind picked names that kind, several are «lines», nothing yet follows the tab.
  const kind: Tab | 'lines' =
    summaries.length > 1
      ? 'lines'
      : productBatch.length > 0
        ? 'products'
        : partsBatch.length > 0
          ? 'parts'
          : plateBatch.length > 0
            ? 'plate'
            : tab;
  const submitLabel =
    kind === 'parts'
      ? t('orders.add.submit.parts')
      : kind === 'plate'
        ? t('orders.add.submit.plate')
        : t('orders.add.submit.products', { count: lines.length });

  return (
    <Modal
      onClose={onClose}
      title={t('orders.add.title')}
      size="6xl"
      footer={
        <>
          <span className="mr-auto flex flex-wrap gap-x-4 text-sm text-bambu-gray">
            {summaries.map((s) => (
              <span key={s}>{s}</span>
            ))}
          </span>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => targetId != null && add.mutate(targetId)} disabled={!canSubmit}>
            {submitLabel}
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
          {tab === 'parts' && <PartsTab picks={parts} onPicksChange={setParts} />}
          {tab === 'plate' && <PlateTab pick={plate} onPickChange={setPlate} />}
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
