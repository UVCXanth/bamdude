import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { api } from '../../../api/client';
import type { BatchLine } from '../../../api/client';
import { useToast } from '../../../contexts/ToastContext';
import { useSearchBox } from '../../../hooks/useSearchBox';
import { useStockSuggest } from '../../../hooks/useStockSuggest';
import { invalidateOrderViews } from '../../../utils/queryInvalidation';
import { Button } from '../../Button';
import { Select } from '../../Select';
import { WorkshopDialog } from '../../workshop/WorkshopDialog';
import { WorkshopTabPanel, WorkshopTabs } from '../../workshop/WorkshopTabs';
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
  shownForLines,
  suggestItems,
} from './addToOrderState';
import type { PartPicks, PlatePick, ProductPicks, Shown } from './addToOrderState';
import { useTabScroll } from './useTabScroll';

type Tab = 'products' | 'parts' | 'plate';
const TABS: Tab[] = ['products', 'parts', 'plate'];
const ORDER_PAGE = 20;

/** The order the dialog adds to, as its caller knows it. */
export interface AddTarget {
  id: number;
  code: string;
  name: string;
  /** A completed or cancelled order takes nothing from stock (rule 7). */
  active: boolean;
}

/**
 * «Add to order» (spec workshop-add-to-order, rules 19–25; WS-13 E5 B / G):
 * products, parts of a product and a one-off plate, picked across searches,
 * pages and tabs, and added in ONE batch — one transaction on the server, so a
 * refused line adds nothing.
 *
 * Opened from an order (`order`) it adds to that order; opened from a product it
 * asks which ACTIVE order first, opens on that product — searched for by its
 * code, so it is on the page to edit (final review I4) — and after the batch
 * goes to the order the batch was added to (the mockup's `add-go`, E5 K4).
 *
 * ⚠️ A tab mounts on its first visit and stays mounted, hidden: its search,
 * filters, page and sideways scroll live with its DOM, and a tab nobody opened
 * asks the server nothing. The body's vertical scroll is not the panel's — it is
 * remembered per tab (`useTabScroll`, E5 R06).
 *
 * ⚠️ While the batch is in flight nothing changes: the X, Escape and «Cancel»
 * are off and every field sits in a disabled fieldset (E5 R09) — the draft that
 * closes on success is exactly the one that was sent.
 */
export function AddToOrderDialog({
  order,
  preselectProduct,
  onClose,
}: {
  order?: AddTarget;
  preselectProduct?: { id: number; code: string };
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const idBase = useId();
  const anchor = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<Tab>('products');
  const [visited, setVisited] = useState<Set<Tab>>(() => new Set(['products']));
  const [chosen, setChosen] = useState<{ id: number; code: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [products, setProducts] = useState<ProductPicks>(() =>
    preselectProduct ? new Map([[preselectProduct.id, newProductPick()]]) : new Map(),
  );
  const [parts, setParts] = useState<PartPicks>(() => new Map());
  const [plate, setPlate] = useState<PlatePick>(null);

  const showTab = useCallback((next: Tab) => {
    setVisited((prev) => (prev.has(next) ? prev : new Set(prev).add(next)));
    setTab(next);
  }, []);
  const switchTo = useTabScroll(tab, showTab, anchor);
  // B06: the first focus goes where a person starts typing — the order search from a product,
  // else the open tab's search. Here, in the dialog itself: `Modal` focuses its panel in a
  // passive effect, which runs before this one (a child's effects run first).
  useEffect(() => {
    anchor.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
  }, []);

  const target = order ?? chosen;
  // A chosen order came from the active list; a given one says what it is.
  const takesStock = order ? order.active : true;
  const items = useMemo(() => suggestItems(products), [products]);
  // Only proposals that answer what each row asks NOW reach the rows and the batch (E5 R02).
  const { current, status, refreshFailed, retry } = useStockSuggest(items, takesStock);

  // Everything picked on every tab goes in ONE batch — one transaction, so a
  // refused line adds nothing (spec rule 11).
  const productBatch = productLines(products, current, takesStock);
  const partsBatch = partsLines(parts);
  const plateBatch = plateLines(plate);
  const lines: BatchLine[] = [...productBatch, ...partsBatch, ...plateBatch];

  const add = useMutation({
    // The batch and `shown` ride together: what was sent and what the rows showed, both
    // taken from the render in which «Add» was pressed (C06).
    mutationFn: ({ id, lines: batch }: { id: number; lines: BatchLine[]; shown: Shown[] }) => api.addOrderLines(id, batch),
    onMutate: () => setError(null),
    onSuccess: (result, { id, shown }) => {
      // Both shelves' keys are order views (`ORDER_VIEW_KEYS`), each once.
      invalidateOrderViews(qc, { orderId: id });
      showToast(t('orders.add.added', { count: result.results.length }));
      const short = shortfalls(result, shown);
      if (short.length > 0) {
        // Each line names only the shelf that gave less.
        const detail = short
          .map((s) => {
            const what = [
              s.gotFinished < s.askedFinished &&
                t('orders.add.clampedReady', { got: s.gotFinished, asked: s.askedFinished }),
              s.gotKits < s.askedKits && t('orders.add.clampedKits', { got: s.gotKits, asked: s.askedKits }),
            ]
              .filter(Boolean)
              .join(', ');
            return t('orders.add.clampedLine', { name: s.name, what });
          })
          .join('; ');
        showToast(t('orders.add.clamped', { detail }), 'warning');
      }
      onClose();
      // From a product: the order the batch went to — the mutation's own id, not
      // whatever the field says by now (E5 R09).
      if (!order) navigate(`/projects/${id}`);
    },
    // The server's sentence in the dialog; the controls come back with every pick.
    onError: (err: Error) => setError(err.message),
  });
  const pending = add.isPending;

  const canSubmit = target != null && lines.length > 0 && !pending;
  const summaries = [
    products.size > 0 && t('orders.add.summary.products', { count: products.size, units: productUnits(products) }),
    // B03: a kind after another continues the line («… · деталей: N · …»), alone it opens it.
    parts.size > 0 &&
      t(products.size > 0 ? 'orders.add.summary.partsNext' : 'orders.add.summary.parts', {
        count: parts.size,
        units: partUnits(parts),
      }),
    plate?.plateIndex != null &&
      t(products.size > 0 || parts.size > 0 ? 'orders.add.summary.plateNext' : 'orders.add.summary.plate', {
        n: plate.plateIndex,
        copies: plate.copies,
      }),
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
  const submitLabel = pending
    ? t('orders.add.adding')
    : kind === 'parts'
      ? t('orders.add.submit.parts')
      : kind === 'plate'
        ? t('orders.add.submit.plate')
        : t('orders.add.submit.products', { count: lines.length });

  return (
    <WorkshopDialog
      onClose={onClose}
      title={t('orders.add.title')}
      subtitle={target ? `${target.code} · ${target.name}` : t('orders.add.chooseOrderSubtitle')}
      size="xl"
      pending={pending}
      error={error}
      summary={summaries.length > 0 ? summaries.join(' · ') : t('orders.add.nothing')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={() =>
              target != null && !pending && add.mutate({ id: target.id, lines, shown: shownForLines(products, current, takesStock) })
            }
            disabled={!canSubmit}
          >
            {submitLabel}
          </Button>
        </>
      }
    >
      <div ref={anchor} className="space-y-3">
        {!order && (
          <fieldset disabled={pending} className="m-0 min-w-0 border-0 p-0">
            <OrderChoice value={chosen} onChange={setChosen} />
          </fieldset>
        )}
        <WorkshopTabs
          idBase={idBase}
          ariaLabel={t('orders.add.title')}
          value={tab}
          items={TABS.map((key) => ({ value: key, label: t(`orders.add.tabs.${key}`) }))}
          onChange={switchTo}
          size="detail"
          panels="all"
        />
        {!takesStock && <p className="text-sm text-bambu-gray">{t('orders.add.inactive')}</p>}
        <fieldset disabled={pending} className="m-0 min-w-0 border-0 p-0">
          {TABS.map((key) => (
            <WorkshopTabPanel key={key} idBase={idBase} value={key} hidden={tab !== key}>
              {visited.has(key) && key === 'products' && (
                <ProductsTab
                  picks={products}
                  onPicksChange={setProducts}
                  takesStock={takesStock}
                  stockOf={(id) => ({
                    suggestion: current.get(id),
                    status: status.get(id) ?? 'waiting',
                    refreshFailed: refreshFailed.has(id),
                  })}
                  onRetryStock={retry}
                  initialQuery={preselectProduct?.code}
                />
              )}
              {visited.has(key) && key === 'parts' && <PartsTab picks={parts} onPicksChange={setParts} />}
              {visited.has(key) && key === 'plate' && <PlateTab pick={plate} onPickChange={setPlate} />}
            </WorkshopTabPanel>
          ))}
        </fieldset>
      </div>
    </WorkshopDialog>
  );
}

type ChosenOrder = { id: number; code: string; name: string };

/**
 * Which active order to add to (spec rule 25; WS-13 E5 G02) — a server search by
 * code, name and customer, one page of 20. A chosen order a new search no longer
 * lists stays chosen, under its own label.
 */
function OrderChoice({ value, onChange }: { value: ChosenOrder | null; onChange: (order: ChosenOrder | null) => void }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const setQuery = useCallback((next: string) => setQ(next), []);
  const { typed, setTyped } = useSearchBox(q, setQuery);
  // The chosen order's label, kept for when a new search no longer lists it.
  const [chosenLabel, setChosenLabel] = useState('');
  const params = { status: 'active' as const, ...(q ? { q } : {}), page: 1, per_page: ORDER_PAGE };
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['orders', 'add-to-order', params],
    queryFn: () => api.getOrdersPaged(params),
  });
  const orders = data?.items ?? [];
  const label = (o: { code: string; name: string; customer_name: string | null }) =>
    `${o.code} · ${o.name} · ${o.customer_name ?? t('orders.add.noCustomer')}`;
  const total = data?.meta.total ?? 0;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="text-sm text-bambu-gray">{t('orders.add.toOrder')}</span>
      <input
        type="search"
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        placeholder={t('orders.add.findOrder')}
        aria-label={t('orders.add.findOrder')}
        className="min-h-[44px] rounded-lg border border-bambu-dark-tertiary bg-bambu-dark px-3 py-2 text-sm text-white focus:border-bambu-green focus:outline-none md:min-h-0"
      />
      <Select
        aria-label={t('orders.add.order')}
        value={value == null ? '' : String(value.id)}
        disabled={isPending}
        onChange={(e) => {
          const id = e.target.value ? Number(e.target.value) : null;
          const found = orders.find((o) => o.id === id);
          if (found) {
            setChosenLabel(label(found));
            onChange({ id: found.id, code: found.code, name: found.name });
          } else if (id == null) {
            onChange(null);
          }
        }}
        className="min-w-64"
      >
        <option value="">{t('orders.add.chooseOrder')}</option>
        {/* A chosen order a new search no longer lists still shows as chosen. */}
        {value != null && !orders.some((o) => o.id === value.id) && (
          <option value={String(value.id)}>{chosenLabel}</option>
        )}
        {orders.map((o) => (
          <option key={o.id} value={String(o.id)}>
            {label(o)}
          </option>
        ))}
      </Select>
      {isPending ? (
        <span className="text-sm text-bambu-gray">{t('orders.add.orderLoading')}</span>
      ) : isError ? (
        <span className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-400">
          {t('orders.add.orderFailed')}
          <Button size="sm" variant="ghost" onClick={() => refetch()}>
            {t('common.retry')}
          </Button>
        </span>
      ) : orders.length === 0 ? (
        <span className="text-sm text-bambu-gray">{q ? t('orders.add.noOrdersFound') : t('orders.add.noActiveOrders')}</span>
      ) : total > orders.length ? (
        <span className="text-sm text-bambu-gray">{t('orders.add.shownOf', { shown: orders.length, total })}</span>
      ) : null}
    </div>
  );
}
