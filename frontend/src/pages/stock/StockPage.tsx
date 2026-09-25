import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Loader2, Warehouse } from 'lucide-react';
import type { StockListItem, StockListParams } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { Button } from '../../components/Button';
import { ListPageHeader } from '../../components/ListPageHeader';
import { ListSearchBox } from '../../components/ListSearchBox';
import { PaginationBar } from '../../components/PaginationBar';
import { ProjectsTabs } from '../../components/projects/ProjectsTabs';
import { AdjustStockDialog } from '../../components/products/AdjustStockDialog';
import { StockJournal } from '../../components/stock/StockJournal';
import { StockProductsTable } from '../../components/stock/StockProductsTable';
import { StockTiles } from '../../components/stock/StockTiles';
import { useListUrlState } from '../../hooks/useListUrlState';
import { parsePageSize, usePersistedState } from '../../hooks/usePersistedState';
import { useSearchBox } from '../../hooks/useSearchBox';
import { useStockPage } from '../../hooks/useStock';

/**
 * The fourth root of the Projects section: the farm-wide shelf.
 *
 * The list is one page from the server, like every list of the section (spec
 * workshop-lists, rules 9, 17): search, «only with stock», sort and page live
 * in the URL; the page size is the viewer's preference. The tiles above are the
 * whole shelf, never the list's filters. Data before status: with a page on
 * screen a failed refetch leaves it there and the hook's `refreshToast`
 * reports it once; with nothing yet, a spinner or the sentence.
 */
export function StockPage() {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const canEdit = hasPermission('projects:update');

  const { page, q, sort, extra, setPage, setQ, setSort, setExtra, resetFilters, clampToLastPage } = useListUrlState({
    defaults: { sort: 'kits-desc', extra: { stock: '1' } },
  });
  const onlyWithStock = extra.stock !== '0';
  const { typed, setTyped, forget } = useSearchBox(q, setQ);
  const [perPage, setPerPage] = usePersistedState<number>('bamdude-stock-perPage', 24, parsePageSize);
  const [adjusting, setAdjusting] = useState<StockListItem | null>(null);

  // `with_stock` is sent only when it departs from the server's default, and
  // `q` only when there is one — an absent key, not `undefined`, so the query
  // key and the request agree with each other.
  const params: StockListParams = {
    ...(onlyWithStock ? {} : { with_stock: false }),
    ...(q ? { q } : {}),
    sort_by: sort,
    page,
    ...(perPage === -1 ? { all: true } : { per_page: perPage }),
  };
  const { data, isError, isPlaceholderData } = useStockPage(params);
  // A shelf that shrank (or a stale bookmark) can leave us past the last page.
  // Only an answer for THIS view may clamp — see the orders page.
  useEffect(() => {
    if (data && !isPlaceholderData) clampToLastPage(data.meta.last_page);
  }, [data, isPlaceholderData, clampToLastPage]);

  const total = data?.meta.total ?? 0;
  const filtered = q !== '' || !onlyWithStock;

  return (
    <div className="p-4">
      <ProjectsTabs />

      <ListPageHeader
        title={t('stock.page.title')}
        subtitle={t('stock.page.intro')}
        icon={<Warehouse className="w-6 h-6 text-bambu-green" />}
      />

      <StockTiles />

      <div className="flex items-center gap-3 flex-wrap mb-4">
        <ListSearchBox value={typed} onChange={setTyped} placeholder={t('stock.page.search')} />
        <label className="flex items-center gap-2 text-sm text-bambu-gray">
          <input
            type="checkbox"
            checked={onlyWithStock}
            onChange={(e) => setExtra('stock', e.target.checked ? '1' : '0')}
          />
          {t('stock.page.onlyWithStock')}
        </label>
      </div>

      {!data ? (
        isError ? (
          <p className="text-sm text-red-500" data-testid="stock-error">{t('stock.page.error')}</p>
        ) : (
          <p className="flex items-center gap-2 text-sm text-bambu-gray"><Loader2 className="w-4 h-4 animate-spin" />{t('common.loading')}</p>
        )
      ) : total === 0 ? (
        filtered ? (
          <div className="flex items-center gap-3 text-sm text-bambu-gray" data-testid="stock-empty">
            <span>{t('stock.page.emptyFiltered')}</span>
            <Button
              variant="secondary"
              onClick={() => {
                forget();
                resetFilters();
              }}
            >
              {t('list.empty.reset')}
            </Button>
          </div>
        ) : (
          <p className="text-sm text-bambu-gray" data-testid="stock-empty">{t('stock.page.empty')}</p>
        )
      ) : (
        // The previous page stays on screen while the next one loads — dimmed
        // and marked busy, so it is not read as the answer to the new question.
        <div
          data-testid="list-body"
          aria-busy={isPlaceholderData}
          className={`transition-opacity ${isPlaceholderData ? 'opacity-60' : ''}`}
        >
          <StockProductsTable
            products={data.items}
            canEdit={canEdit}
            onAdjust={setAdjusting}
            sort={sort}
            onSortChange={setSort}
            footer={
              <PaginationBar
                page={data.meta.current_page}
                totalPages={data.meta.last_page}
                perPage={perPage}
                total={total}
                onPageChange={setPage}
                onPerPageChange={(n) => {
                  setPerPage(n);
                  setPage(1);
                }}
                items={t('stock.page.items', { count: total })}
                variant="card"
              />
            }
          />
        </div>
      )}

      <div className="mt-8">
        <StockJournal />
      </div>

      {adjusting && (
        <AdjustStockDialog
          productId={adjusting.id}
          parts={adjusting.parts.map((b) => ({ part_id: b.part_id, name: b.name }))}
          onClose={() => setAdjusting(null)}
          onSaved={() => {
            queryClient.invalidateQueries({ queryKey: ['stock-summary'] });
            queryClient.invalidateQueries({ queryKey: ['stock-movements'] });
          }}
        />
      )}
    </div>
  );
}
