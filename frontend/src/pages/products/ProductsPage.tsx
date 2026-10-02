import { useEffect, useRef, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { FileBox, Plus, Upload } from 'lucide-react';
import { api } from '../../api/client';
import type { Product, ProductListItem } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { invalidateAfterDelete, invalidateOrderViews, invalidateProductCatalog } from '../../utils/queryInvalidation';
import { ProductCard } from '../../components/products/ProductCard';
import { ProductsTable } from '../../components/products/ProductsTable';
import { ListPageHeader } from '../../components/ListPageHeader';
import { ListSearchBox } from '../../components/ListSearchBox';
import { ListViewToggle } from '../../components/ListViewToggle';
import { ListSortControl } from '../../components/ListSortControl';
import type { ListView } from '../../components/ListViewToggle';
import { PaginationBar } from '../../components/PaginationBar';
import { useCardsTableViews } from '../../hooks/useCardsTableViews';
import { useListUrlState } from '../../hooks/useListUrlState';
import { parseListView, parsePageSize, usePersistedState } from '../../hooks/usePersistedState';
import { useSearchBox } from '../../hooks/useSearchBox';
import { ProductCardDialog } from '../../components/products/ProductCardDialog';
import { AddToOrderDialog } from '../../components/projects/add-to-order/AddToOrderDialog';
import { FromFileDialog } from '../../components/products/FromFileDialog';
import { ImportProductDialog } from '../../components/products/ImportProductDialog';
import { ConfirmModal } from '../../components/ConfirmModal';
import { Button } from '../../components/Button';
import { CategoryPanel } from '../../components/products/CategoryPanel';
import { CategoryManagerDialog } from '../../components/products/CategoryManagerDialog';
import { CatalogFilters, type CatalogFilterValues } from '../../components/products/CatalogFilters';
import { catalogStatus, catalogStock } from '../../components/products/catalogUrl';
import { ProductsSkeleton } from '../../components/products/ProductsSkeleton';
import { WorkshopPanel } from '../../components/workshop/WorkshopPanel';
import { LoadFailedNote } from '../../components/workshop/LoadFailedNote';
import { RefreshFailedNote } from '../../components/workshop/RefreshFailedNote';
import { answeredEmpty, listFigure, listState } from '../../utils/listState';

/**
 * The product catalog.
 *
 * One page at a time from the SERVER (`GET /products?page=…`, spec
 * projects-lists-parity): search, the catalog toggle and the sort are asked of
 * it, because a catalog of thousands must not travel so that a search box can
 * narrow it. The place in the list — page, search, sort, the toggle — lives in
 * the URL (Back, F5 and a shared link land on the same view); the view mode and
 * the page size are the viewer's preferences, kept in localStorage.
 *
 * The category panel and the filters (spec workshop-product-catalog) are
 * request parameters too; the panel's counts come with the page.
 *
 * WS-13 E8 C: the mockup's page — the catalog's figure under the heading, the wide
 * search over the row of filters, the categories beside the results, and every state
 * of the read said (`listState`: a skeleton, a failed key as an alert with its retry,
 * a failed re-read as a note) — never «no products» for «could not ask».
 */
export function ProductsPage() {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const { page, q, sort, extra, setPage, setQ, setSort, setExtra, resetFilters, clampToLastPage } = useListUrlState({
    defaults: {
      sort: 'name-asc',
      extra: { catalog: '1', adhoc: '', category: '', material: '', color: '', model: '', status: '', stock: '' },
    },
  });
  // WS-13 E8 C04 (R01): the URL keeps its old values. `catalog=0` was always «the hidden
  // ones too» — now the «hidden» box; anything else is the default. A readiness or stock
  // the closed sets do not know is no filter, and opening such a link rewrites nothing.
  const hidden = extra.catalog === '0';
  const adhoc = extra.adhoc === '1';
  const status = catalogStatus(extra.status);
  const stock = catalogStock(extra.stock);
  const filters: CatalogFilterValues = {
    material: extra.material,
    color: extra.color,
    model: extra.model,
    status,
    stock,
    hidden,
    adhoc,
  };
  const setFilter = <K extends keyof CatalogFilterValues>(key: K, value: CatalogFilterValues[K]) => {
    if (key === 'hidden') setExtra('catalog', value ? '0' : '');
    else if (key === 'adhoc') setExtra('adhoc', value ? '1' : '');
    else setExtra(key, String(value));
  };
  const [managing, setManaging] = useState(false);
  const directoryQuery = useQuery({
    queryKey: ['product-categories'],
    queryFn: () => api.getProductCategories(),
    staleTime: 60_000,
  });
  const facetsQuery = useQuery({
    queryKey: ['product-facets'],
    queryFn: () => api.getProductFacets(),
    staleTime: 60_000,
  });
  // Nothing chosen → the table (WS-13 E2 B05); the catalog's order does not depend on the view.
  const [view, setView] = usePersistedState<ListView>('bamdude-products-view', 'table', parseListView);
  const views = useCardsTableViews();
  const [perPage, setPerPage] = usePersistedState<number>('bamdude-products-perPage', 24, parsePageSize);
  const { typed, setTyped, forget } = useSearchBox(q, setQ);
  const [editing, setEditing] = useState<ProductListItem | null | 'new'>(null);
  const [fromFile, setFromFile] = useState(false);
  const [importing, setImporting] = useState(false);
  const [deleting, setDeleting] = useState<ProductListItem | null>(null);
  // «To order…» from a card or a row (WS-13 E5 G01): the dialog opens on that product.
  const [addingToOrder, setAddingToOrder] = useState<ProductListItem | null>(null);

  // `active: false` would be a filter of its own ("only what is hidden"), which
  // «hidden» does not offer — on means "no filter", so the key is absent.
  const params = {
    ...(hidden ? {} : { active: true }),
    ...(adhoc ? { include_adhoc: true } : {}),
    ...(q ? { q } : {}),
    ...(extra.category ? { category: extra.category } : {}),
    ...(extra.material ? { material: extra.material } : {}),
    ...(extra.color ? { color: extra.color } : {}),
    // «Not sliced» is the server's `sliced=false`, never a model called «none».
    ...(extra.model === 'none' ? { sliced: false } : extra.model ? { model: extra.model } : {}),
    ...(status ? { status } : {}),
    ...(stock ? { stock: stock === 'low' ? ('below_min' as const) : stock } : {}),
    sort_by: sort,
    page,
    ...(perPage === -1 ? { all: true } : { per_page: perPage }),
  };

  const { data, isError, isPlaceholderData, refetch } = useQuery({
    queryKey: ['products', params],
    // Arrow, never `queryFn: api.getProductsPaged` — TanStack would hand the
    // query context to a function whose only parameter is the params object.
    queryFn: () => api.getProductsPaged(params),
    // The old page stays on screen while the next one loads — no flash.
    placeholderData: keepPreviousData,
  });
  const products = data?.items ?? [];
  const total = data?.meta.total ?? 0;
  // WS-13 E8 C08: one reading of the list's state — a failed key is an alert, never «no products».
  const state = listState({ data, isError, isPlaceholderData });
  // The empty explanation stays under a failed re-read of an empty answer (E7-V01).
  const emptyAnswer = answeredEmpty(state, data);
  // A delete (ours or someone else's) can leave us past the last page. Only an
  // answer for THIS view may clamp: the previous page's, still on screen while
  // the next loads, knows nothing about how many pages the new filter has.
  useEffect(() => {
    if (data && !isPlaceholderData) clampToLastPage(data.meta.last_page);
  }, [data, isPlaceholderData, clampToLastPage]);
  // What NARROWS the list — an empty answer under it is «nothing found». «hidden» and
  // «one-off» widen it, so an empty answer with only those is the catalog's own emptiness.
  const narrowed =
    q !== '' || [extra.category, extra.material, extra.color, extra.model, status, stock].some(Boolean);
  // Every condition Reset clears (C05) — the widening ones too.
  const condition = narrowed || hidden || adhoc;
  const searchRef = useRef<HTMLInputElement>(null);
  const resetConditions = () => {
    forget();
    resetFilters();
    searchRef.current?.focus();
  };
  const subtitle = data
    ? t('products.list.subtitle', { count: data.catalog_total })
    : state === 'failed'
      ? t('products.list.subtitleFailed')
      : t('products.list.subtitleNoCount');
  const resultsTitle = !extra.category
    ? t('products.catalog.all')
    : extra.category === 'none'
      ? t('products.catalog.uncategorized')
      : (directoryQuery.data?.find((c) => String(c.id) === extra.category)?.name ??
        data?.categories.find((c) => String(c.id) === extra.category)?.name ??
        t('products.catalog.unknownCategory', { id: extra.category }));

  const sortOptions = [
    { key: 'name', label: t('products.table.name') },
    { key: 'sku', label: t('products.table.sku') },
    { key: 'category', label: t('products.table.category') },
    { key: 'status', label: t('products.table.status') },
    { key: 'updated', label: t('list.sort.updated'), descFirst: true },
    { key: 'created', label: t('list.sort.created'), descFirst: true },
    { key: 'parts', label: t('products.table.parts'), descFirst: true },
    { key: 'plates', label: t('products.table.plates'), descFirst: true },
    { key: 'orders', label: t('products.table.orders'), descFirst: true },
    { key: 'kits', label: t('products.table.kits'), descFirst: true },
  ];

  const pageBar = (variant: 'card' | 'bare') =>
    data ? (
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
        items={t('products.list.items', { count: total })}
        variant={variant}
      />
    ) : null;

  const toggleActive = useMutation({
    mutationFn: (product: ProductListItem) => api.updateProduct(product.id, { is_active: !product.is_active }),
    onSuccess: (saved) => {
      // ⚠️ The order views, which since Ruling 29 include the product keys: a
      // product that leaves the catalog is still on the lines of every order
      // that ordered it, and the cards and pickers reading those lines have to
      // be told. Naming `['product', id]` and `['products']` again here was two
      // refetches of each for one toggle.
      invalidateOrderViews(queryClient);
      showToast(saved.is_active ? t('products.toast.shown') : t('products.toast.hidden'));
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.deleteProduct(id),
    // The LISTS, from the one place that decides which ones — an order card
    // renders the deleted product's cover, so `['projects']` goes with
    // `['products']` and neither site gets its own opinion about that. The id
    // goes too: from a grid, the deleted product's own detail entry is a ghost
    // nobody is watching — see `utils/queryInvalidation`.
    onSuccess: (_res, id) => {
      invalidateAfterDelete(queryClient, 'product', id);
      showToast(t('products.toast.deleted'));
      setDeleting(null);
    },
    // A product an order line uses answers 409 — the server's own sentence is
    // what the toast says, and the grid is left exactly as it was.
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  const duplicate = useMutation({
    mutationFn: (id: number) => api.duplicateProduct(id),
    // ⚠️ No order view moves here, deliberately: the copy is a brand-new
    // product that no order line names yet. Invalidating them would refetch
    // every order on the way out of a page nobody is coming back to.
    onSuccess: (saved) => {
      invalidateProductCatalog(queryClient);
      showToast(t('products.toast.duplicated'));
      navigate(`/products/${saved.id}`);
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  const openCreated = (created: Product) => {
    setFromFile(false);
    navigate(`/products/${created.id}`);
  };

  return (
    <div className="workshop p-4">
      <ListPageHeader title={t('products.list.title')} subtitle={subtitle}>
        <ListViewToggle value={view} options={views} onChange={setView} />
        {hasPermission('projects:create') && (
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => setFromFile(true)}>
              <FileBox className="w-4 h-4" />
              {t('products.list.fromFile')}
            </Button>
            {/* An import INGESTS FILES INTO THE LIBRARY, so the server asks for
                the upload permission beside `projects:create`. The button is
                shown to anyone who may create a product — the refusal, when it
                comes, is the server's own sentence in the dialog. */}
            <Button variant="secondary" onClick={() => setImporting(true)}>
              <Upload className="w-4 h-4" />
              {t('products.list.import')}
            </Button>
            <Button onClick={() => setEditing('new')}>
              <Plus className="w-4 h-4" />
              {t('products.list.newProduct')}
            </Button>
          </div>
        )}
      </ListPageHeader>

      {/* WS-13 E8 C02 / C03: the search is a row of its own, the filters under it — both
          above the categories and the results, as the mockup lays them. */}
      <div className="mb-4">
        <ListSearchBox
          value={typed}
          onChange={setTyped}
          placeholder={t('products.list.search')}
          layout="wide"
          inputRef={searchRef}
        />
        <div className="mt-3">
          <CatalogFilters
            values={filters}
            onChange={setFilter}
            facets={facetsQuery.data}
            facetsFailed={facetsQuery.isError}
            onRetryFacets={() => facetsQuery.refetch()}
            // Only while a condition holds; an empty answer under one carries its own (C05).
            onReset={condition && !(emptyAnswer && narrowed) ? resetConditions : undefined}
          />
        </div>
      </div>

      {/* C06: clamp(180px, 11vw, 240px) beside the results, 180 at 1100 and narrower, one
          column at 760 and narrower. ⚠️ Tailwind 4's `max-[N]` is `width < N`. */}
      <div className="grid gap-5 grid-cols-[clamp(180px,11vw,240px)_minmax(0,1fr)] max-[1101px]:grid-cols-[180px_minmax(0,1fr)] max-[761px]:grid-cols-1">
        <CategoryPanel
          directory={directoryQuery.data}
          directoryFailed={directoryQuery.isError}
          onRetryDirectory={() => directoryQuery.refetch()}
          figures={data ? { categories: data.categories, uncategorized: data.uncategorized, all: data.all_categories } : undefined}
          state={state}
          selected={extra.category}
          onSelect={(value) => setExtra('category', value)}
          onManage={hasPermission('projects:update') ? () => setManaging(true) : undefined}
        />
        <div className="min-w-0">
          {/* C07: the chosen category and the server's total under every filter. */}
          <div className="flex items-center justify-between gap-2.5 mb-2.5 flex-wrap">
            <h3 className="text-base font-semibold text-white">
              {resultsTitle}
              <span
                data-testid="results-count"
                className="ml-1.5 inline-block rounded-full bg-bambu-dark-tertiary px-2 py-px align-middle text-xs font-medium text-bambu-gray tabular-nums"
              >
                {listFigure(state, total)}
              </span>
            </h3>
            <div className="flex items-center gap-3">
              {emptyAnswer && <small className="text-xs text-bambu-gray">{t('products.list.noResults')}</small>}
              {/* A table sorts from its headers; the cards need a control of their own. */}
              {view === 'cards' && <ListSortControl sort={sort} options={sortOptions} onChange={setSort} />}
            </div>
          </div>

          {state === 'loading' && <ProductsSkeleton view={view} />}
          {state === 'failed' && <LoadFailedNote message={t('products.list.loadFailed')} onRetry={() => refetch()} />}
          {state === 'refresh-failed' && <RefreshFailedNote onRetry={() => refetch()} />}

          {emptyAnswer &&
            (narrowed ? (
              <WorkshopPanel>
                <div className="px-4 py-10 text-center text-sm text-bambu-gray">
                  <p className="mb-1 text-base font-semibold text-white">{t('products.list.noMatchTitle')}</p>
                  <p>
                    {t('products.list.noMatchHint')}{' '}
                    <Button variant="ghost" onClick={resetConditions}>
                      {t('products.list.resetFilters')}
                    </Button>
                  </p>
                </div>
              </WorkshopPanel>
            ) : (
              <p className="text-bambu-gray text-sm">{t('products.list.empty')}</p>
            ))}

          {/* The previous page stays on screen while the next one loads — dimmed
              and marked busy, so it is not read as the answer to the new question. */}
          {data && !emptyAnswer && (
            <div
              data-testid="list-body"
              aria-busy={isPlaceholderData}
              className={`transition-opacity ${isPlaceholderData ? 'opacity-60' : ''}`}
            >
              {view === 'table' && products.length > 0 ? (
                <ProductsTable
                  products={products}
                  sort={sort}
                  onSortChange={setSort}
                  onEdit={setEditing}
                  onDuplicate={(p) => duplicate.mutate(p.id)}
                  onToggleActive={(p) => toggleActive.mutate(p)}
                  onDelete={setDeleting}
                  onAddToOrder={setAddingToOrder}
                  footer={pageBar('card')}
                />
              ) : (
                <>
                  <div className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(280px,1fr))]">
                    {products.map((product) => (
                      <ProductCard
                        key={product.id}
                        product={product}
                        onEdit={setEditing}
                        onDuplicate={(p) => duplicate.mutate(p.id)}
                        onToggleActive={(p) => toggleActive.mutate(p)}
                        onDelete={setDeleting}
                        onAddToOrder={setAddingToOrder}
                      />
                    ))}
                  </div>
                  {total > 0 && <div className="mt-4">{pageBar('bare')}</div>}
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {managing && (
        <CategoryManagerDialog
          onClose={() => setManaging(false)}
          // A deleted category the list is filtered by would leave an empty
          // list under a selection that no longer exists.
          onDeleted={(id) => {
            if (extra.category === String(id)) setExtra('category', '');
          }}
        />
      )}

      {editing && <ProductCardDialog product={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}

      {fromFile && <FromFileDialog onClose={() => setFromFile(false)} onCreated={openCreated} />}

      {importing && <ImportProductDialog onClose={() => setImporting(false)} />}

      {addingToOrder && (
        <AddToOrderDialog
          preselectProduct={{ id: addingToOrder.id, code: addingToOrder.code }}
          onClose={() => setAddingToOrder(null)}
        />
      )}

      {deleting && (
        <ConfirmModal
          title={t('products.confirm.deleteTitle')}
          message={t('products.confirm.deleteBody')}
          confirmText={t('common.delete')}
          variant="danger"
          isLoading={remove.isPending}
          onConfirm={() => remove.mutate(deleting.id)}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
