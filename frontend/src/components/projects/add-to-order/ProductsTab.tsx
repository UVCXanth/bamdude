import { useCallback, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Package } from 'lucide-react';
import { api } from '../../../api/client';
import type { ProductListItem, StockSuggestion } from '../../../api/client';
import { useProductDetail } from '../../../hooks/useProductDetail';
import { useSearchBox } from '../../../hooks/useSearchBox';
import { getColorName } from '../../../utils/colors';
import { ListSearchBox } from '../../ListSearchBox';
import { PaginationBar } from '../../PaginationBar';
import { Select } from '../../Select';
import { ProductStatusBadge } from '../../products/ProductStatusBadge';
import { MAX_LINE_QTY, newProductPick, shownStock, withStock } from './addToOrderState';
import type { ProductPick, ProductPicks } from './addToOrderState';

const PAGE_SIZE = 24;

/**
 * «Products» of the add-to-order dialog (spec workshop-add-to-order, rule 20).
 *
 * The catalog comes a page at a time from the server — search, category and
 * printer model are request parameters; the picks are the dialog's and outlive
 * the page. Stock numbers are the server's proposal (`suggestions`); a changed
 * number makes the row the operator's until «pick» hands it back.
 */
export function ProductsTab({
  picks,
  onPicksChange,
  takesStock,
  suggestions,
  suggestFailed = false,
  initialQuery = '',
}: {
  picks: ProductPicks;
  onPicksChange: (next: ProductPicks) => void;
  /** Only an active order takes stock (rule 7) — otherwise there is no stock column. */
  takesStock: boolean;
  suggestions: Map<number, StockSuggestion>;
  /** The last `/stock/suggest` failed — the picked rows say so. */
  suggestFailed?: boolean;
  /** Opens already searched — the product page opens on its own product. */
  initialQuery?: string;
}) {
  const { t } = useTranslation();
  const [q, setQState] = useState(initialQuery);
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(PAGE_SIZE);
  const [category, setCategory] = useState('');
  const [model, setModel] = useState('');
  const setQ = useCallback((value: string) => {
    setQState(value);
    setPage(1);
  }, []);
  const { typed, setTyped } = useSearchBox(q, setQ);

  const { data: directory = [] } = useQuery({
    queryKey: ['product-categories'],
    queryFn: () => api.getProductCategories(),
    staleTime: 60_000,
  });
  const { data: facets } = useQuery({
    queryKey: ['product-facets'],
    queryFn: () => api.getProductFacets(),
    staleTime: 60_000,
  });

  const params = {
    page,
    ...(perPage === -1 ? { all: true } : { per_page: perPage }),
    active: true,
    ...(q ? { q } : {}),
    ...(category ? { category } : {}),
    ...(model ? { model } : {}),
  };
  const { data } = useQuery({
    queryKey: ['products', params],
    queryFn: () => api.getProductsPaged(params),
    placeholderData: keepPreviousData,
  });
  const rows = data?.items ?? [];

  const update = (id: number, pick: ProductPick | null) => {
    const next = new Map(picks);
    if (pick) next.set(id, pick);
    else next.delete(id);
    onPicksChange(next);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <ListSearchBox value={typed} onChange={setTyped} placeholder={t('orders.add.searchProducts')} layout="picker" />
        <Select
          tone="filter"
          active={category !== ''}
          aria-label={t('products.catalog.categories')}
          value={category}
          onChange={(e) => {
            setCategory(e.target.value);
            setPage(1);
          }}
        >
          <option value="">{t('products.catalog.all')}</option>
          <option value="none">{t('products.catalog.uncategorized')}</option>
          {directory.map((c) => (
            <option key={c.id} value={String(c.id)}>
              {c.name}
            </option>
          ))}
        </Select>
        <Select
          tone="filter"
          active={model !== ''}
          aria-label={t('products.catalog.model')}
          value={model}
          onChange={(e) => {
            setModel(e.target.value);
            setPage(1);
          }}
        >
          <option value="">{t('products.catalog.anyModel')}</option>
          {(facets?.models ?? []).map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </Select>
      </div>

      <div className="overflow-x-auto rounded-lg border border-bambu-dark-tertiary">
        <table className="w-full text-sm">
          <thead className="bg-bambu-dark-tertiary/50 text-bambu-gray">
            <tr>
              <th className="p-2 w-8" aria-label={t('orders.add.pick')} />
              <th className="font-normal p-2 text-left">{t('orders.lines.product')}</th>
              <th className="font-normal p-2 text-left">{t('orders.add.configuration')}</th>
              <th className="font-normal p-2 text-left">{t('orders.lines.quantity')}</th>
              {takesStock && <th className="font-normal p-2 text-left">{t('orders.add.stock.title')}</th>}
              <th className="font-normal p-2 text-left">{t('orders.add.materialColor')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((product) => (
              <ProductRow
                key={product.id}
                product={product}
                pick={picks.get(product.id)}
                suggestion={suggestions.get(product.id)}
                suggestFailed={suggestFailed}
                takesStock={takesStock}
                onChange={(pick) => update(product.id, pick)}
              />
            ))}
            {data && rows.length === 0 && (
              <tr>
                <td colSpan={takesStock ? 6 : 5} className="p-6 text-center text-bambu-gray">
                  {t('orders.add.noProducts')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <PaginationBar
          page={page}
          totalPages={data?.meta.last_page ?? 1}
          perPage={perPage}
          total={data?.meta.total ?? 0}
          onPageChange={setPage}
          onPerPageChange={(n) => {
            setPerPage(n);
            setPage(1);
          }}
          items={t('orders.add.productsNoun')}
        />
      </div>
    </div>
  );
}

function ProductRow({
  product,
  pick,
  suggestion,
  suggestFailed,
  takesStock,
  onChange,
}: {
  product: ProductListItem;
  pick: ProductPick | undefined;
  suggestion: StockSuggestion | undefined;
  suggestFailed: boolean;
  takesStock: boolean;
  onChange: (pick: ProductPick | null) => void;
}) {
  const { t } = useTranslation();
  const set = (patch: Partial<ProductPick>) => pick && onChange({ ...pick, ...patch });
  return (
    <tr data-testid={`add-product-${product.id}`} className="border-t border-bambu-dark-tertiary text-white align-top">
      <td className="p-2">
        <input
          type="checkbox"
          checked={pick !== undefined}
          onChange={(e) => onChange(e.target.checked ? newProductPick() : null)}
          aria-label={product.name}
          className="accent-bambu-green mt-2"
        />
      </td>
      <td className="p-2">
        <div className="flex items-start gap-2">
          {product.has_cover ? (
            <img
              src={api.getProductCoverImageUrl(product.id)}
              alt=""
              className="w-9 h-9 flex-shrink-0 rounded object-contain bg-bambu-dark"
            />
          ) : (
            <span className="w-9 h-9 flex-shrink-0 rounded bg-bambu-dark flex items-center justify-center">
              <Package className="w-4 h-4 text-bambu-gray" />
            </span>
          )}
          <div className="min-w-0">
            <div className="truncate">{product.name}</div>
            <div className="text-xs text-bambu-gray">
              {[product.code, product.sku, product.category?.name].filter(Boolean).join(' · ')}
            </div>
            <div className="flex flex-wrap items-center gap-1 mt-0.5">
              <ProductStatusBadge product={product} />
              {product.models.length > 0 && (
                <span className="text-xs text-bambu-gray">{product.models.join(', ')}</span>
              )}
            </div>
          </div>
        </div>
      </td>
      <td className="p-2">{pick && <PickedConfiguration productId={product.id} pick={pick} onChange={onChange} />}</td>
      <td className="p-2">
        <input
          type="number"
          min={1}
          max={MAX_LINE_QTY}
          value={pick?.qty ?? 1}
          disabled={!pick}
          onChange={(e) => set({ qty: Math.min(MAX_LINE_QTY, Math.max(1, Math.floor(Number(e.target.value)) || 1)) })}
          aria-label={t('orders.lines.quantity')}
          className="w-20 px-2 py-1 bg-bambu-dark border border-bambu-dark-tertiary rounded text-white disabled:opacity-50"
        />
      </td>
      {takesStock && (
        <td className="p-2">
          {pick ? (
            <StockCell pick={pick} suggestion={suggestion} failed={suggestFailed} onChange={onChange} />
          ) : (
            <span className="text-bambu-gray whitespace-nowrap">
              {t('orders.add.stock.listed', { ready: product.finished_available, kits: product.kits_available })}
            </span>
          )}
        </td>
      )}
      <td className="p-2">
        {pick && (
          <div className="flex flex-col gap-1">
            <Select
              size="sm"
              aria-label={t('products.catalog.material')}
              value={pick.material}
              onChange={(e) => set({ material: e.target.value })}
            >
              <option value="">{t('products.catalog.anyMaterial')}</option>
              {product.materials.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
            <Select
              size="sm"
              aria-label={t('products.catalog.color')}
              value={pick.color}
              onChange={(e) => set({ color: e.target.value })}
            >
              <option value="">{t('products.catalog.anyColor')}</option>
              {product.colors.map((c) => (
                <option key={c} value={c}>
                  {getColorName(c)}
                </option>
              ))}
            </Select>
          </div>
        )}
      </td>
    </tr>
  );
}

/** A group `Select` per variant group — list rows carry no groups, so a picked row reads its product. */
function PickedConfiguration({
  productId,
  pick,
  onChange,
}: {
  productId: number;
  pick: ProductPick;
  onChange: (pick: ProductPick) => void;
}) {
  const { t } = useTranslation();
  const { data: product } = useProductDetail(productId);
  if (!product) return null;
  if (product.variant_groups.length === 0) {
    return <span className="text-bambu-gray">{t('orders.add.noVariants')}</span>;
  }
  return (
    <div className="flex flex-col gap-1">
      {product.variant_groups.map((group) => (
        <Select
          key={group.id}
          size="sm"
          aria-label={group.name}
          value={String(pick.choices[group.id] ?? group.default_option_id ?? '')}
          onChange={(e) => onChange({ ...pick, choices: { ...pick.choices, [group.id]: Number(e.target.value) } })}
        >
          {group.options.map((option) => (
            <option key={option.id} value={String(option.id)}>
              {option.name}
            </option>
          ))}
        </Select>
      ))}
    </div>
  );
}

function StockCell({
  pick,
  suggestion,
  failed,
  onChange,
}: {
  pick: ProductPick;
  suggestion: StockSuggestion | undefined;
  failed: boolean;
  onChange: (pick: ProductPick) => void;
}) {
  const { t } = useTranslation();
  const shown = shownStock(pick, suggestion);
  const nothing = suggestion !== undefined && suggestion.finished_free === 0 && suggestion.kits_free === 0;
  const field = (name: 'fromFinished' | 'fromKits', label: string, word: string, free: number | undefined) => (
    <span className="flex items-center gap-1 whitespace-nowrap">
      <span className="text-bambu-gray">{word}</span>
      <input
        type="number"
        min={0}
        value={shown[name]}
        onChange={(e) => onChange(withStock(pick, suggestion, name, Number(e.target.value)))}
        aria-label={label}
        className="w-16 px-2 py-0.5 bg-bambu-dark border border-bambu-dark-tertiary rounded text-white"
      />
      <span className="text-bambu-gray">{t('orders.add.stock.of', { n: free ?? '—' })}</span>
    </span>
  );
  return (
    <div className="flex flex-col gap-1 text-xs">
      {field('fromFinished', t('orders.add.stock.readyLabel'), t('orders.add.stock.ready'), suggestion?.finished_free)}
      {field('fromKits', t('orders.add.stock.kitsLabel'), t('orders.add.stock.kits'), suggestion?.kits_free)}
      <span className="flex items-center gap-2">
        {failed && !suggestion && <span className="text-red-400">{t('orders.add.stock.failed')}</span>}
        {pick.auto ? (
          suggestion && (
            <span className="text-bambu-gray">{t(nothing ? 'orders.add.stock.none' : 'orders.add.stock.auto')}</span>
          )
        ) : (
          <button type="button" onClick={() => onChange({ ...pick, auto: true })} className="text-bambu-green hover:underline">
            {t('orders.add.stock.pick')}
          </button>
        )}
        <span className="text-white">{t('orders.add.stock.toPrint', { n: shown.toPrint })}</span>
      </span>
    </div>
  );
}
