import { useCallback, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../../api/client';
import type { ProductPartRow } from '../../../api/client';
import { useSearchBox } from '../../../hooks/useSearchBox';
import { ListSearchBox } from '../../ListSearchBox';
import { PaginationBar } from '../../PaginationBar';
import { Select } from '../../Select';
import { MAX_PART_COUNT } from './addToOrderState';
import type { PartPicks } from './addToOrderState';

const PAGE_SIZE = 24;

/**
 * «Parts of a product» (spec workshop-add-to-order, rule 21): the printed parts
 * of catalog products, a server page at a time. Parts of one product become one
 * «parts only» line when added.
 */
export function PartsTab({ picks, onPicksChange }: { picks: PartPicks; onPicksChange: (next: PartPicks) => void }) {
  const { t } = useTranslation();
  const [q, setQState] = useState('');
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(PAGE_SIZE);
  const [model, setModel] = useState('');
  const setQ = useCallback((value: string) => {
    setQState(value);
    setPage(1);
  }, []);
  const { typed, setTyped } = useSearchBox(q, setQ);

  const { data: facets } = useQuery({
    queryKey: ['product-facets'],
    queryFn: () => api.getProductFacets(),
    staleTime: 60_000,
  });
  const params = {
    page,
    // The picker is paged — the server refuses the whole list (WS-13 E1 K7).
    per_page: perPage,
    ...(q ? { q } : {}),
    ...(model ? { model } : {}),
  };
  const { data } = useQuery({
    queryKey: ['product-parts', params],
    queryFn: () => api.getProductParts(params),
    placeholderData: keepPreviousData,
  });
  const rows = data?.items ?? [];

  const toggle = (row: ProductPartRow, on: boolean) => {
    const next = new Map(picks);
    if (on) next.set(row.part_id, { productId: row.product.id, qty: 1 });
    else next.delete(row.part_id);
    onPicksChange(next);
  };
  const setQty = (row: ProductPartRow, value: number) => {
    const next = new Map(picks);
    next.set(row.part_id, { productId: row.product.id, qty: Math.min(MAX_PART_COUNT, Math.max(1, Math.floor(value) || 1)) });
    onPicksChange(next);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <ListSearchBox value={typed} onChange={setTyped} placeholder={t('orders.add.parts.search')} layout="picker" />
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
              <th className="font-normal p-2 text-left">{t('orders.parts.name')}</th>
              <th className="font-normal p-2 text-left">{t('orders.lines.product')}</th>
              <th className="font-normal p-2 text-left">{t('products.catalog.model')}</th>
              <th className="font-normal p-2 text-left">{t('orders.add.parts.qty')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const pick = picks.get(row.part_id);
              return (
                <tr key={row.part_id} data-testid={`add-part-${row.part_id}`} className="border-t border-bambu-dark-tertiary text-white">
                  <td className="p-2">
                    <input
                      type="checkbox"
                      checked={pick !== undefined}
                      onChange={(e) => toggle(row, e.target.checked)}
                      aria-label={row.name}
                      className="accent-bambu-green"
                    />
                  </td>
                  <td className="p-2">
                    <span>{row.name}</span>
                    {row.variant && (
                      <span className="ml-2 inline-block px-2 py-0.5 rounded-full text-xs bg-bambu-dark-tertiary text-bambu-gray">
                        {t('orders.add.parts.variant', { group: row.variant.group, option: row.variant.option })}
                      </span>
                    )}
                  </td>
                  <td className="p-2 text-bambu-gray">
                    {[row.product.name, row.product.sku, row.product.code].filter(Boolean).join(' · ')}
                  </td>
                  <td className="p-2 text-bambu-gray">{row.models.join(', ')}</td>
                  <td className="p-2">
                    <input
                      type="number"
                      min={1}
                      max={MAX_PART_COUNT}
                      value={pick?.qty ?? 1}
                      disabled={!pick}
                      onChange={(e) => setQty(row, Number(e.target.value))}
                      aria-label={t('orders.add.parts.qty')}
                      className="w-20 px-2 py-1 bg-bambu-dark border border-bambu-dark-tertiary rounded text-white disabled:opacity-50"
                    />
                  </td>
                </tr>
              );
            })}
            {data && rows.length === 0 && (
              <tr>
                <td colSpan={5} className="p-6 text-center text-bambu-gray">
                  {t('orders.add.parts.none')}
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
          items={t('orders.add.parts.noun')}
          allowAll={false}
        />
      </div>
    </div>
  );
}
