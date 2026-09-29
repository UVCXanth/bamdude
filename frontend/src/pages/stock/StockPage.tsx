import { useEffect, useId, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router';
import { ArrowDownToLine, Loader2, Warehouse, Wrench } from 'lucide-react';
import type { StockItem, StockItemsMode, StockItemsParams, StockListItem, StockListParams } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { Button } from '../../components/Button';
import { ListPageHeader } from '../../components/ListPageHeader';
import { ListSearchBox } from '../../components/ListSearchBox';
import { PaginationBar } from '../../components/PaginationBar';
import { AdjustStockDialog } from '../../components/products/AdjustStockDialog';
import { FinishedGoodsTable } from '../../components/stock/FinishedGoodsTable';
import type { FinishedAction } from '../../components/stock/FinishedGoodsTable';
import { FinishedTiles } from '../../components/stock/FinishedTiles';
import { StockDialogs } from '../../components/stock/StockDialogs';
import type { StockDialogState } from '../../components/stock/StockDialogs';
import { StockJournal } from '../../components/stock/StockJournal';
import { DispatchNotesTable } from '../../components/stock/DispatchNotesTable';
import { useDispatchNotes } from '../../hooks/useDispatchNotes';
import { StockProductsTable } from '../../components/stock/StockProductsTable';
import { StockTiles } from '../../components/stock/StockTiles';
import { useListUrlState } from '../../hooks/useListUrlState';
import { parsePageSize, usePersistedState } from '../../hooks/usePersistedState';
import { useSearchBox } from '../../hooks/useSearchBox';
import { useStockItems } from '../../hooks/useFinishedStock';
import { useStockPage } from '../../hooks/useStock';
import { invalidateStock } from '../../utils/queryInvalidation';
import { WorkshopTabPanel, WorkshopTabs } from '../../components/workshop/WorkshopTabs';

const TABS = ['finished', 'parts', 'journal', 'notes'] as const;
type StockTab = (typeof TABS)[number];
const MODES: StockItemsMode[] = ['tracked', 'low', 'reserved', 'all'];

/**
 * The fourth root of the Projects section: the farm's stock (spec
 * workshop-finished-goods, rule 23) — finished goods first, then the free
 * parts shelf, then the journal of both.
 *
 * The tab is a PLACE and lives in the URL; each tab keeps its own search,
 * sort, page and filters there too, and a tab switch starts the new tab clean
 * — the sort keys of one tab mean nothing on another. Every list is one page
 * from the server (spec workshop-lists, rules 9, 17); the tiles are each tab's
 * own and summarise the whole farm, never the list's filters.
 */
export function StockPage() {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('projects:update');
  const [dialog, setDialog] = useState<StockDialogState>(null);
  const tabsId = useId();
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const tab: StockTab = (TABS as readonly string[]).includes(raw ?? '') ? (raw as StockTab) : 'finished';

  const switchTab = (next: StockTab) => {
    if (next === tab) return;
    // One write, nothing carried over: the default tab is the clean URL.
    setParams(next === 'finished' ? {} : { tab: next }, { replace: true });
  };

  const label: Record<StockTab, string> = {
    finished: t('stock.tabs.finished'),
    parts: t('stock.tabs.parts'),
    journal: t('stock.tabs.journal'),
    notes: t('stock.tabs.notes'),
  };

  return (
    <div className="p-4">
      <ListPageHeader
        title={t('stock.page.title')}
        subtitle={t('stock.page.intro')}
        icon={<Warehouse className="w-6 h-6 text-bambu-green" />}
      >
        {canEdit && (
          <>
            <Button variant="secondary" onClick={() => setDialog({ kind: 'assemble' })}>
              <Wrench className="w-4 h-4" />
              {t('stock.finished.assembleOpen')}
            </Button>
            <Button onClick={() => setDialog({ kind: 'receipt' })}>
              <ArrowDownToLine className="w-4 h-4" />
              {t('stock.finished.action.receipt')}
            </Button>
          </>
        )}
      </ListPageHeader>

      <div className="mb-4">
        <WorkshopTabs
          idBase={tabsId}
          ariaLabel={t('stock.tabs.label')}
          value={tab}
          items={TABS.map((key) => ({ value: key, label: label[key] }))}
          onChange={switchTab}
        />
      </div>

      <WorkshopTabPanel idBase={tabsId} value={tab}>
        {tab === 'finished' && <FinishedTab onDialog={setDialog} />}
        {tab === 'parts' && <PartsTab />}
        {tab === 'journal' && <StockJournal />}
        {tab === 'notes' && <NotesTab />}
      </WorkshopTabPanel>

      <StockDialogs dialog={dialog} onClose={() => setDialog(null)} />
    </div>
  );
}

/** Dispatch notes of the whole farm — searched, sorted and paged on the server (spec workshop-dispatch-notes, rule 20). */
function NotesTab() {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const { page, q, sort, setPage, setQ, setSort, resetFilters, clampToLastPage } = useListUrlState({
    defaults: { sort: 'created-desc' },
  });
  const { typed, setTyped, forget } = useSearchBox(q, setQ);
  const [perPage, setPerPage] = usePersistedState<number>('bamdude-dispatch-notes-perPage', 24, parsePageSize);
  const { data, isError, isPlaceholderData } = useDispatchNotes({
    ...(q ? { q } : {}),
    sort_by: sort,
    page,
    ...(perPage === -1 ? { all: true } : { per_page: perPage }),
  });
  useEffect(() => {
    if (data && !isPlaceholderData) clampToLastPage(data.meta.last_page);
  }, [data, isPlaceholderData, clampToLastPage]);
  const total = data?.meta.total ?? 0;

  return (
    <>
      <div className="flex items-center gap-3 flex-wrap mb-4">
        <ListSearchBox value={typed} onChange={setTyped} placeholder={t('stock.notes.search')} />
      </div>
      {!data ? (
        isError ? (
          <p className="text-sm text-red-500" data-testid="notes-error">{t('stock.notes.error')}</p>
        ) : (
          <p className="flex items-center gap-2 text-sm text-bambu-gray"><Loader2 className="w-4 h-4 animate-spin" />{t('common.loading')}</p>
        )
      ) : total === 0 ? (
        q ? (
          <div className="flex items-center gap-3 text-sm text-bambu-gray" data-testid="notes-empty">
            <span>{t('stock.notes.emptyFiltered')}</span>
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
          <p className="text-sm text-bambu-gray" data-testid="notes-empty">{t('stock.notes.emptyTab')}</p>
        )
      ) : (
        <div
          data-testid="list-body"
          aria-busy={isPlaceholderData}
          className={`transition-opacity ${isPlaceholderData ? 'opacity-60' : ''}`}
        >
          <DispatchNotesTable
            items={data.items}
            sort={sort}
            onSortChange={setSort}
            canEdit={hasPermission('projects:update')}
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
                items={t('stock.notes.items')}
                variant="card"
              />
            }
          />
        </div>
      )}
    </>
  );
}

/** Finished goods: positions on record, under the minimum, reserved, or all (rule 24). */
function FinishedTab({ onDialog }: { onDialog: (dialog: StockDialogState) => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('projects:update');

  const { page, q, sort, extra, setPage, setQ, setSort, setExtra, resetFilters, clampToLastPage } = useListUrlState({
    defaults: { sort: 'product-asc', extra: { mode: 'tracked' } },
  });
  const mode: StockItemsMode = (MODES as string[]).includes(extra.mode) ? (extra.mode as StockItemsMode) : 'tracked';
  const { typed, setTyped, forget } = useSearchBox(q, setQ);
  const [perPage, setPerPage] = usePersistedState<number>('bamdude-stock-items-perPage', 24, parsePageSize);

  const params: StockItemsParams = {
    mode,
    ...(q ? { q } : {}),
    sort_by: sort,
    page,
    ...(perPage === -1 ? { all: true } : { per_page: perPage }),
  };
  const { data, isError, isPlaceholderData } = useStockItems(params);
  useEffect(() => {
    if (data && !isPlaceholderData) clampToLastPage(data.meta.last_page);
  }, [data, isPlaceholderData, clampToLastPage]);

  const onAction = (kind: FinishedAction, item: StockItem) => {
    if (kind === 'open') navigate(`/stock/${item.id}`);
    else onDialog({ kind, item });
  };

  const total = data?.meta.total ?? 0;
  const filtered = q !== '' || mode !== 'tracked';

  return (
    <>
      <FinishedTiles />

      <div className="flex items-center gap-3 flex-wrap mb-4">
        <div className="flex rounded-lg border border-bambu-dark-tertiary overflow-hidden" role="group" aria-label={t('stock.finished.modeLabel')}>
          {MODES.map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={mode === key}
              onClick={() => setExtra('mode', key)}
              className={`px-3 py-1.5 text-sm transition-colors ${
                mode === key ? 'bg-bambu-dark-tertiary text-white' : 'text-bambu-gray hover:text-white'
              }`}
            >
              {t(`stock.finished.mode.${key}`)}
            </button>
          ))}
        </div>
        <ListSearchBox value={typed} onChange={setTyped} placeholder={t('stock.finished.search')} />
      </div>

      {!data ? (
        isError ? (
          <p className="text-sm text-red-500" data-testid="finished-error">{t('stock.page.error')}</p>
        ) : (
          <p className="flex items-center gap-2 text-sm text-bambu-gray"><Loader2 className="w-4 h-4 animate-spin" />{t('common.loading')}</p>
        )
      ) : total === 0 ? (
        filtered ? (
          <div className="flex items-center gap-3 text-sm text-bambu-gray" data-testid="finished-empty">
            <span>{t('stock.finished.emptyFiltered')}</span>
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
          <p className="text-sm text-bambu-gray" data-testid="finished-empty">{t('stock.finished.empty')}</p>
        )
      ) : (
        <div
          data-testid="list-body"
          aria-busy={isPlaceholderData}
          className={`transition-opacity ${isPlaceholderData ? 'opacity-60' : ''}`}
        >
          <FinishedGoodsTable
            items={data.items}
            sort={sort}
            onSortChange={setSort}
            canEdit={canEdit}
            onAction={onAction}
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
                items={t('stock.finished.items', { count: total })}
                variant="card"
              />
            }
          />
        </div>
      )}
    </>
  );
}

/**
 * The free-parts shelf — the tab as it was before finished goods, unchanged:
 * search, «only with stock», sort and page in the URL; the page size is the
 * viewer's preference. Data before status: with a page on screen a failed
 * refetch leaves it there and the hook's `refreshToast` reports it once.
 */
function PartsTab() {
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
    <>
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

      {adjusting && (
        <AdjustStockDialog
          productId={adjusting.id}
          parts={adjusting.parts.map((b) => ({ part_id: b.part_id, name: b.name }))}
          onClose={() => setAdjusting(null)}
          onSaved={() => invalidateStock(queryClient)}
        />
      )}
    </>
  );
}
