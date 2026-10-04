import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, STOCK_ITEM_KINDS, STOCK_REASONS } from '../../api/client';
import type { StockJournalBook, StockJournalProduct, StockJournalRow } from '../../api/client';
import { useStockJournalPage, useStockJournalProducts } from '../../hooks/useFinishedStock';
import type { StockJournalPageParams } from '../../hooks/useFinishedStock';
import { useListUrlState } from '../../hooks/useListUrlState';
import { parsePageSize, usePersistedState } from '../../hooks/usePersistedState';
import { formatDateTime } from '../../utils/date';
import type { DateFormat, TimeFormat } from '../../utils/date';
import { answeredEmpty, listState } from '../../utils/listState';
import { Button } from '../Button';
import { PaginationBar } from '../PaginationBar';
import { isNoteToken, signed } from '../products/stockMovementHelpers';
import { lineConfigLabel } from '../projects/lineConfigLabel';
import { Select } from '../Select';
import { SortableHeader } from '../SortableHeader';
import { LoadFailedNote } from '../workshop/LoadFailedNote';
import { RefreshFailedNote } from '../workshop/RefreshFailedNote';
import { WorkshopPanel, WorkshopTableScroll } from '../workshop/WorkshopPanel';
import { StockTableSkeleton } from './StockTableSkeleton';

const BOOKS: StockJournalBook[] = ['both', 'finished', 'parts'];
const SORTS = ['date-desc', 'date-asc'] as const;
type JournalSort = (typeof SORTS)[number];
/** The journal's page size — a preference, never «all» (E12 E01). */
const PER_PAGE_KEY = 'bamdude-stock-journal-perPage';
const DEFAULT_PER_PAGE = 24;

/** The operations the kind filter offers for a ledger — both ledgers' when both are read. */
function kindsFor(book: StockJournalBook): string[] {
  if (book === 'finished') return [...STOCK_ITEM_KINDS];
  if (book === 'parts') return [...STOCK_REASONS];
  return [...STOCK_ITEM_KINDS, ...STOCK_REASONS.filter((r) => !(STOCK_ITEM_KINDS as readonly string[]).includes(r))];
}

/**
 * Both stock ledgers as one feed (spec workshop-finished-goods, rules 21, 27; WS-13 E12 E):
 * finished-goods movements and free-parts movements side by side, in the server's numbered
 * pages (`page` mode, ST1) — never a cursor and «Show older».
 *
 * On the stock page's tab the filters are the PLACE and live in the URL; on a position
 * page (`itemId`) the feed is that position's — its own movements and the parts that went
 * into it — and its ledger, operation, sort and page live in the page's memory, starting
 * over for another position.
 */
export function StockJournal({ itemId }: { itemId?: number }) {
  return itemId != null ? <PositionJournal key={itemId} itemId={itemId} /> : <TabJournal />;
}

/** The journal's page size, read once: a stored «all» from another list reads as the default. */
function useJournalPerPage() {
  const [stored, setPerPage] = usePersistedState<number>(PER_PAGE_KEY, DEFAULT_PER_PAGE, parsePageSize);
  return [stored === -1 ? DEFAULT_PER_PAGE : stored, setPerPage] as const;
}

/**
 * The tab: `?book=`, `?product=`, `?kind=`, `?page=`, `?sort=` — defaults never written, a
 * filter change starts page 1. A new book and the operation it drops are ONE write (R05).
 *
 * The product filter offers what the chosen books moved (`GET /stock/journal/products`, ST2).
 * ⚠️ A chosen product is dropped only by a SUCCESSFUL answer of the CURRENT book's list
 * that does not hold it: while that list is read, or after it failed, the product stays and
 * is named from what is known — the list of the previous book, the rows, else «product #id».
 * A late answer for another book never writes: the effect reads only the current key's own
 * data. The page is normalised only by an answer of its own key.
 */
function TabJournal() {
  const { t } = useTranslation();
  const { page, sort, extra, setPage, setSort, setExtra, setExtras, resetFilters, clampToLastPage } = useListUrlState({
    defaults: { sort: 'date-desc', extra: { book: 'both', product: '', kind: '' } },
  });
  const book: StockJournalBook = (BOOKS as string[]).includes(extra.book) ? (extra.book as StockJournalBook) : 'both';
  const kind = kindsFor(book).includes(extra.kind) ? extra.kind : '';
  const parsedProduct = Number(extra.product);
  const productId = Number.isInteger(parsedProduct) && parsedProduct > 0 ? parsedProduct : undefined;
  const sortBy: JournalSort = (SORTS as readonly string[]).includes(sort) ? (sort as JournalSort) : 'date-desc';
  const [perPage, setPerPage] = useJournalPerPage();

  const params: StockJournalPageParams = {
    book,
    ...(productId != null ? { product_id: productId } : {}),
    ...(kind ? { kind } : {}),
    page,
    per_page: perPage,
    sort_by: sortBy,
  };
  const journal = useStockJournalPage(params);
  const list = useStockJournalProducts(book);
  const queryClient = useQueryClient();

  // Each book is read NOW (Codex E12-V03): a list cached from an earlier visit names the
  // options, but the product goes only on «not in this book» from an answer read after the
  // switch — never while that read is on its way, never from a failed one (R05).
  useEffect(() => {
    void list.refetch({ cancelRefetch: false });
    // The book is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book]);
  const listed = list.isSuccess && !list.isPlaceholderData ? list.data : undefined;
  const confirmed = listed && list.isFetchedAfterMount && !list.isFetching ? listed : undefined;
  useEffect(() => {
    if (productId != null && confirmed && !confirmed.some((p) => p.id === productId)) setExtra('product', '');
  }, [productId, confirmed, setExtra]);

  const meta = journal.data?.meta;
  useEffect(() => {
    if (journal.isSuccess && !journal.isPlaceholderData && meta) clampToLastPage(meta.last_page);
  }, [journal.isSuccess, journal.isPlaceholderData, meta, clampToLastPage]);

  const rows = journal.data?.items ?? [];
  const nameOf = (id: number) =>
    list.data?.find((p) => p.id === id)?.name ??
    // The list of the book it was chosen in (R05): a book shown from its own cache has no
    // placeholder of the previous one to name it by (Codex E12-V03).
    queryClient
      .getQueriesData<StockJournalProduct[]>({ queryKey: ['stock-journal-products'] })
      .flatMap(([, seen]) => seen ?? [])
      .find((p) => p.id === id)?.name ??
    rows.find((r) => r.product_id === id)?.product_name ??
    t('stock.journal.productN', { id });
  const options = listed ?? [];

  const productFilter = (
    <div className="flex items-center gap-2">
      <Select
        aria-label={t('stock.page.filterProduct')}
        value={productId ?? ''}
        onChange={(e) => setExtra('product', e.target.value)}
      >
        <option value="">{t('stock.page.anyProduct')}</option>
        {options.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
        {productId != null && !options.some((p) => p.id === productId) && (
          <option value={productId}>{nameOf(productId)}</option>
        )}
      </Select>
      {list.isError ? (
        <span className="flex items-center gap-2 text-xs text-bambu-gray">
          {t('stock.journal.productsFailed')}
          <Button size="sm" variant="ghost" onClick={() => list.refetch()}>
            {t('common.retry')}
          </Button>
        </span>
      ) : (
        !listed && (
          <span role="status" className="text-xs text-bambu-gray">
            {t('stock.journal.productsLoading')}
          </span>
        )
      )}
    </div>
  );

  return (
    <JournalView
      journal={journal}
      book={book}
      kind={kind}
      onBook={(next) => setExtras({ book: next, kind: '' })}
      onKind={(next) => setExtra('kind', next)}
      productFilter={productFilter}
      sort={sortBy}
      onSort={setSort}
      perPage={perPage}
      onPage={setPage}
      onPerPage={(n) => {
        setPerPage(n);
        setPage(1);
      }}
      filtered={book !== 'both' || productId != null || kind !== ''}
      onReset={() => resetFilters()}
    />
  );
}

/** A position's feed: the ledger and the operation, the sort and the page — in memory.
 *  The page names it («Movement journal», E12 F05). */
function PositionJournal({ itemId }: { itemId: number }) {
  const [book, setBook] = useState<StockJournalBook>('both');
  const [kind, setKind] = useState('');
  const [sort, setSort] = useState<JournalSort>('date-desc');
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useJournalPerPage();
  const journal = useStockJournalPage({
    book,
    item_id: itemId,
    ...(kind ? { kind } : {}),
    page,
    per_page: perPage,
    sort_by: sort,
  });
  const meta = journal.data?.meta;
  useEffect(() => {
    if (journal.isSuccess && !journal.isPlaceholderData && meta && meta.last_page >= 1 && page > meta.last_page) {
      setPage(meta.last_page);
    }
  }, [journal.isSuccess, journal.isPlaceholderData, meta, page]);

  return (
    <JournalView
      journal={journal}
      book={book}
      kind={kind}
      onBook={(next) => {
        setBook(next);
        setKind('');
        setPage(1);
      }}
      onKind={(next) => {
        setKind(next);
        setPage(1);
      }}
      sort={sort}
      onSort={(next) => {
        setSort((SORTS as readonly string[]).includes(next) ? (next as JournalSort) : 'date-desc');
        setPage(1);
      }}
      perPage={perPage}
      onPage={setPage}
      onPerPage={(n) => {
        setPerPage(n);
        setPage(1);
      }}
      filtered={book !== 'both' || kind !== ''}
      onReset={() => {
        setBook('both');
        setKind('');
        setPage(1);
      }}
    />
  );
}

interface JournalViewProps {
  journal: ReturnType<typeof useStockJournalPage>;
  book: StockJournalBook;
  kind: string;
  onBook: (book: StockJournalBook) => void;
  onKind: (kind: string) => void;
  /** The tab's product filter; a position has none. */
  productFilter?: ReactNode;
  sort: JournalSort;
  onSort: (sort: string) => void;
  perPage: number;
  onPage: (page: number) => void;
  onPerPage: (n: number) => void;
  filtered: boolean;
  onReset: () => void;
}

/** The toolbar, the states and the table — one shape for the tab and a position. */
function JournalView({
  journal,
  book,
  kind,
  onBook,
  onKind,
  productFilter,
  sort,
  onSort,
  perPage,
  onPage,
  onPerPage,
  filtered,
  onReset,
}: JournalViewProps) {
  const { t } = useTranslation();
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings, staleTime: 60_000 });
  const dateFormat = (settings?.date_format || 'system') as DateFormat;
  const timeFormat = (settings?.time_format || 'system') as TimeFormat;

  const meta = journal.data?.meta ?? undefined;
  const answer = meta ? { meta } : undefined;
  const state = listState({ data: answer, isError: journal.isError, isPlaceholderData: journal.isPlaceholderData });
  const emptyAnswer = answeredEmpty(state, answer);
  const rows = journal.data?.items ?? [];

  return (
    <section className="space-y-3" data-testid="stock-journal">
      <div className="flex items-center gap-3 flex-wrap">
        <Select aria-label={t('stock.journal.book')} value={book} onChange={(e) => onBook(e.target.value as StockJournalBook)}>
          {BOOKS.map((b) => (
            <option key={b} value={b}>
              {t(`stock.journal.books.${b}`)}
            </option>
          ))}
        </Select>
        {productFilter}
        <Select aria-label={t('stock.journal.operation')} value={kind} onChange={(e) => onKind(e.target.value)}>
          <option value="">{t('stock.journal.anyOperation')}</option>
          {kindsFor(book).map((k) => (
            <option key={k} value={k}>
              {(STOCK_ITEM_KINDS as readonly string[]).includes(k) ? t(`stock.journal.kind.${k}`) : t(`stock.reason.${k}`)}
            </option>
          ))}
        </Select>
      </div>

      {state === 'loading' && <StockTableSkeleton tab="journal" />}
      {state === 'failed' && <LoadFailedNote message={t('stock.journal.loadFailed')} onRetry={() => journal.refetch()} />}
      {state === 'refresh-failed' && <RefreshFailedNote onRetry={() => journal.refetch()} />}

      {emptyAnswer &&
        (filtered ? (
          <WorkshopPanel>
            <div className="px-4 py-10 text-center text-sm text-bambu-gray">
              <p className="mb-2 text-base font-semibold text-white">{t('stock.page.journalEmptyFiltered')}</p>
              <Button variant="ghost" onClick={onReset}>
                {t('stock.page.resetFilters')}
              </Button>
            </div>
          </WorkshopPanel>
        ) : (
          <p className="text-sm text-bambu-gray">{t('stock.page.journalEmpty')}</p>
        ))}

      {/* The previous page of the SAME feed stays on screen while the next one loads — dimmed
          and marked busy, so it is not read as the answer to the new question. */}
      {meta && !emptyAnswer && (
        <div aria-busy={journal.isPlaceholderData} className={`transition-opacity ${journal.isPlaceholderData ? 'opacity-60' : ''}`}>
          <JournalTable
            rows={rows}
            dateFormat={dateFormat}
            timeFormat={timeFormat}
            sort={sort}
            onSortChange={onSort}
            footer={
              <PaginationBar
                page={meta.current_page}
                totalPages={meta.last_page}
                perPage={perPage}
                total={meta.total}
                onPageChange={onPage}
                onPerPageChange={onPerPage}
                allowAll={false}
                items={t('stock.journal.items', { count: meta.total })}
                variant="card"
              />
            }
          />
        </div>
      )}
    </section>
  );
}

/**
 * The rows of either ledger as one table — the stock page's journal, a position's and,
 * scoped to one product (WS-13 E9 F03), the product page's: there the «Product» column goes,
 * and «What» says «Finished · {configuration}» or the part, so the two units never read
 * alike. Seven columns (E12 E03): the date with its time, the product, what moved, the
 * operation, the signed change, order / dispatch note / note, and who.
 *
 * The names are the answer's own, live; a link is drawn only from an id the answer carries
 * (R06) — the journal keeps no snapshot of its own.
 */
export function JournalTable({
  rows,
  dateFormat,
  timeFormat = 'system',
  scope = 'all',
  sort,
  onSortChange,
  footer,
  label,
}: {
  rows: StockJournalRow[];
  dateFormat: DateFormat;
  timeFormat?: TimeFormat;
  scope?: 'all' | 'product';
  /** With `onSortChange`, the date header sorts on the server (`date-desc` / `date-asc`). */
  sort?: string;
  onSortChange?: (sortBy: string) => void;
  /** The page bar, inside the panel under the rows (outside the scroll). */
  footer?: ReactNode;
  /** The scroll region's name; the stock page's «Movements» by default. */
  label?: string;
}) {
  const { t } = useTranslation();
  const kindLabel = (row: { book: string; kind: string }) =>
    row.book === 'finished'
      ? t(`stock.journal.kind.${row.kind}`, { defaultValue: row.kind })
      : t(`stock.reason.${row.kind}`, { defaultValue: row.kind });
  const plain = (text: string) => <th className="font-normal p-2 text-left">{text}</th>;
  return (
    <WorkshopPanel flush footer={footer}>
      <WorkshopTableScroll label={label ?? t('stock.tabs.journal')}>
        <table className="w-full text-sm">
          <thead className="text-xs text-bambu-gray bg-bambu-dark-secondary">
            <tr>
              {sort !== undefined && onSortChange ? (
                <SortableHeader sortKey="date" label={t('stock.date')} sort={sort} onSort={onSortChange} descFirst />
              ) : (
                plain(t('stock.date'))
              )}
              {scope === 'all' && plain(t('stock.page.product'))}
              {plain(t('stock.journal.what'))}
              {plain(t('stock.journal.operation'))}
              {plain(t('stock.change'))}
              {plain(t('stock.journal.context'))}
              {plain(t('stock.journal.who'))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={`${row.book}-${row.id}`}
                data-testid={`journal-row-${row.book}-${row.id}`}
                className="border-t border-bambu-dark-tertiary text-white align-top"
              >
                {/* ⚠️ `formatDateTime`, never `new Date(x).toLocaleString()`: the column is
                    NAIVE UTC (no `Z`), which the platform parser reads as LOCAL time. */}
                <td className="p-2 text-bambu-gray whitespace-nowrap">
                  <small className="text-xs">{formatDateTime(row.created_at, timeFormat, dateFormat)}</small>
                </td>
                {scope === 'all' && (
                  <td className="p-2">
                    <JournalProduct row={row} />
                  </td>
                )}
                <td className="p-2">
                  <JournalWhat row={row} scope={scope} />
                </td>
                <td className="p-2">{kindLabel(row)}</td>
                <td className="p-2 tabular-nums whitespace-nowrap">
                  <JournalChange row={row} />
                </td>
                <td className="p-2">
                  <JournalContext row={row} />
                </td>
                <td className="p-2 text-bambu-gray">{row.user?.username ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </WorkshopTableScroll>
    </WorkshopPanel>
  );
}

/** The product: a finished row opens its position, a part row its product — by the answer's ids only. */
function JournalProduct({ row }: { row: StockJournalRow }) {
  const name = row.product_name ?? '—';
  const link = 'hover:underline';
  if (row.book === 'finished' && row.item) {
    return (
      <Link to={`/stock/${row.item.id}`} className={link}>
        {name}
      </Link>
    );
  }
  if (row.product_id != null) {
    return (
      <Link to={`/products/${row.product_id}`} className={link}>
        {name}
      </Link>
    );
  }
  return <span>{name}</span>;
}

/** Finished goods and their configuration, or the part (and the position it went into). */
function JournalWhat({ row, scope }: { row: StockJournalRow; scope: 'all' | 'product' }) {
  const { t } = useTranslation();
  const code = row.item ? (
    <Link to={`/stock/${row.item.id}`} className="text-bambu-green hover:underline">
      {row.item.code}
    </Link>
  ) : null;
  if (row.book === 'finished') {
    const caption = row.item ? lineConfigLabel(row.item.configuration, 'product', t) : '';
    if (scope === 'product') {
      // One product's feed mixes finished units and parts: the unit says which it is.
      const finished = t('products.detail.stockTab.finished');
      return (
        <>
          <span>{caption ? `${finished} · ${caption}` : finished}</span>
          {code && <span className="block text-xs">{code}</span>}
        </>
      );
    }
    return (
      <>
        {code}
        {caption && <span className="block text-xs text-bambu-gray">{caption}</span>}
      </>
    );
  }
  return (
    <>
      <span>{row.part_name}</span>
      {code && <span className="block text-xs text-bambu-gray">→ {code}</span>}
    </>
  );
}

/** The change, signed: green onto the shelf, amber off it; a finished row also says what the reservation did. */
function JournalChange({ row }: { row: StockJournalRow }) {
  const { t } = useTranslation();
  const tone = (d: number) => (d > 0 ? 'text-bambu-green' : 'text-status-warning');
  if (row.book === 'parts') return <span className={tone(row.delta)}>{signed(row.delta)}</span>;
  return (
    <>
      {row.delta_on_hand !== 0 && <span className={`block ${tone(row.delta_on_hand)}`}>{signed(row.delta_on_hand)}</span>}
      {row.delta_reserved !== 0 && (
        <span className="block text-xs text-bambu-gray">
          {t('stock.journal.reserveDelta', { d: signed(row.delta_reserved) })}
        </span>
      )}
    </>
  );
}

/** Order · dispatch note · customer (only without an order — the order already says whose,
 *  E03) · note — a server note is a token and is translated; an
 *  operator's is verbatim. Only the parts ledger writes tokens: every finished-goods note is
 *  the operator's own, even one that happens to spell a token. */
function JournalContext({ row }: { row: StockJournalRow }) {
  const { t } = useTranslation();
  const note = row.note ? (row.book === 'parts' && isNoteToken(row.note) ? t(`stock.note.${row.note}`) : row.note) : null;
  const bits = [
    row.project ? (
      <Link key="order" to={`/projects/${row.project.id}`} className="text-bambu-green hover:underline">
        {row.project.code}
      </Link>
    ) : null,
    row.issue ? (
      <Link key="dispatch-note" to={`/stock/dispatch-notes/${row.issue.id}`} className="text-bambu-green hover:underline">
        {row.issue.code}
      </Link>
    ) : null,
    row.customer && !row.project ? <span key="customer">{row.customer.name}</span> : null,
    note ? (
      <span key="note" className="text-bambu-gray">
        {note}
      </span>
    ) : null,
  ].filter(Boolean);
  if (bits.length === 0) return <span className="text-bambu-gray">—</span>;
  return (
    <span className="flex flex-wrap gap-x-1">
      {bits.map((bit, i) => (
        <span key={i}>
          {i > 0 && <span className="text-bambu-gray"> · </span>}
          {bit}
        </span>
      ))}
    </span>
  );
}
