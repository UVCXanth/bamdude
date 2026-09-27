import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { api, STOCK_ITEM_KINDS, STOCK_REASONS } from '../../api/client';
import type { StockJournalBook, StockJournalRow } from '../../api/client';
import { useStockJournal } from '../../hooks/useFinishedStock';
import type { StockJournalQuery } from '../../hooks/useFinishedStock';
import { formatDateOnly } from '../../utils/date';
import type { DateFormat } from '../../utils/date';
import { Button } from '../Button';
import { isNoteToken, signed } from '../products/stockMovementHelpers';
import { lineConfigLabel } from '../projects/lineConfigLabel';
import { Select } from '../Select';

const BOOKS: StockJournalBook[] = ['both', 'finished', 'parts'];

/** The operations the kind filter offers for a ledger — both ledgers' when both are read. */
function kindsFor(book: StockJournalBook): string[] {
  if (book === 'finished') return [...STOCK_ITEM_KINDS];
  if (book === 'parts') return [...STOCK_REASONS];
  return [...STOCK_ITEM_KINDS, ...STOCK_REASONS.filter((r) => !(STOCK_ITEM_KINDS as readonly string[]).includes(r))];
}

/**
 * Both stock ledgers as one feed, newest first (spec workshop-finished-goods,
 * rules 21, 27): finished-goods movements and free-parts movements side by
 * side, the older pages on demand.
 *
 * ⚠️ **The cursor is the server's.** `next_cursor` comes back only on a full
 * page; the hook turns its absence into "no next page", and the footer says so
 * — the operator must never read the oldest row shown as the first movement
 * there ever was. On a position page (`itemId`) the feed is that position's:
 * its own movements and the parts that went into it.
 */
export function StockJournal({ itemId }: { itemId?: number }) {
  const { t } = useTranslation();
  const [book, setBook] = useState<StockJournalBook>('both');
  const [productId, setProductId] = useState<number | undefined>(undefined);
  const [kind, setKind] = useState<string | undefined>(undefined);

  const filters: StockJournalQuery = {
    book,
    ...(itemId != null ? { item_id: itemId } : {}),
    ...(productId != null && itemId == null ? { product_id: productId } : {}),
    ...(kind ? { kind } : {}),
  };
  const { data, isError, hasNextPage, fetchNextPage, isFetchingNextPage } = useStockJournal(filters);
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings, staleTime: 60_000 });
  const dateFormat = (settings?.date_format || 'system') as DateFormat;
  // The product filter's options come from the CATALOG, one-offs included — a
  // product whose shelf just zeroed out still has history, and a one-off can
  // hold parts on the shelf; neither ledger filters by origin.
  const { data: catalog = [] } = useQuery({
    queryKey: ['products', { include_adhoc: true }],
    queryFn: () => api.getProducts({ include_adhoc: true }),
    enabled: itemId == null,
  });

  const rows = data?.pages.flatMap((p) => p.items) ?? [];
  const filtered = book !== 'both' || productId != null || Boolean(kind);

  const kindLabel = (row: { book: string; kind: string }) =>
    row.book === 'finished'
      ? t(`stock.journal.kind.${row.kind}`, { defaultValue: row.kind })
      : t(`stock.reason.${row.kind}`, { defaultValue: row.kind });

  return (
    <section className="space-y-3" data-testid="stock-journal">
      <div className="flex items-end gap-3 flex-wrap">
        <h2 className="text-lg font-medium text-white">{t(itemId != null ? 'stock.journal.positionTitle' : 'stock.page.journal')}</h2>
        <label className="text-xs text-bambu-gray flex flex-col gap-1">
          {t('stock.journal.book')}
          <Select
            value={book}
            onChange={(e) => {
              setBook(e.target.value as StockJournalBook);
              setKind(undefined);
            }}
          >
            {BOOKS.map((b) => (
              <option key={b} value={b}>{t(`stock.journal.books.${b}`)}</option>
            ))}
          </Select>
        </label>
        {itemId == null && (
          <label className="text-xs text-bambu-gray flex flex-col gap-1">
            {t('stock.page.filterProduct')}
            <Select
              value={productId ?? ''}
              onChange={(e) => setProductId(e.target.value ? Number(e.target.value) : undefined)}
            >
              <option value="">{t('stock.page.anyProduct')}</option>
              {catalog.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </Select>
          </label>
        )}
        <label className="text-xs text-bambu-gray flex flex-col gap-1">
          {t('stock.journal.operation')}
          <Select value={kind ?? ''} onChange={(e) => setKind(e.target.value || undefined)}>
            <option value="">{t('stock.journal.anyOperation')}</option>
            {kindsFor(book).map((k) => (
              <option key={k} value={k}>
                {(STOCK_ITEM_KINDS as readonly string[]).includes(k)
                  ? t(`stock.journal.kind.${k}`)
                  : t(`stock.reason.${k}`)}
              </option>
            ))}
          </Select>
        </label>
      </div>

      {!data ? (
        isError ? (
          <p className="text-sm text-red-500">{t('stock.page.error')}</p>
        ) : (
          <p className="flex items-center gap-2 text-sm text-bambu-gray"><Loader2 className="w-4 h-4 animate-spin" />{t('common.loading')}</p>
        )
      ) : rows.length === 0 ? (
        <p className="text-sm text-bambu-gray">
          {t(filtered ? 'stock.page.journalEmptyFiltered' : 'stock.page.journalEmpty')}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-bambu-gray text-left">
                <th className="font-normal p-2">{t('stock.date')}</th>
                <th className="font-normal p-2">{t('stock.page.product')}</th>
                <th className="font-normal p-2">{t('stock.journal.what')}</th>
                <th className="font-normal p-2">{t('stock.journal.operation')}</th>
                <th className="font-normal p-2">{t('stock.change')}</th>
                <th className="font-normal p-2">{t('stock.journal.context')}</th>
                <th className="font-normal p-2">{t('stock.journal.who')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={`${row.book}-${row.id}`}
                  data-testid={`journal-row-${row.book}-${row.id}`}
                  className="border-t border-bambu-dark-tertiary text-white align-top"
                >
                  {/* ⚠️ `formatDateOnly`, never `new Date(x).toLocaleDateString()`:
                      the column is NAIVE UTC (no `Z`), which the platform
                      parser reads as LOCAL time. */}
                  <td className="p-2 text-bambu-gray whitespace-nowrap">{formatDateOnly(row.created_at, undefined, dateFormat)}</td>
                  <td className="p-2">{row.product_name ?? '—'}</td>
                  <td className="p-2"><JournalWhat row={row} /></td>
                  <td className="p-2">{kindLabel(row)}</td>
                  <td className="p-2 tabular-nums whitespace-nowrap"><JournalChange row={row} /></td>
                  <td className="p-2"><JournalContext row={row} /></td>
                  <td className="p-2 text-bambu-gray">{row.user?.username ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && rows.length > 0 && (
        hasNextPage ? (
          <Button size="sm" variant="secondary" onClick={() => fetchNextPage()} disabled={isFetchingNextPage}>
            {t('stock.page.loadOlder')}
          </Button>
        ) : (
          <p className="text-xs text-bambu-gray">{t('stock.page.wholeLedger')}</p>
        )
      )}
    </section>
  );
}

/** Finished goods and their configuration, or the part (and the position it went into). */
function JournalWhat({ row }: { row: StockJournalRow }) {
  const { t } = useTranslation();
  const code = row.item ? (
    <Link to={`/stock/${row.item.id}`} className="text-bambu-green hover:underline">
      {row.item.code}
    </Link>
  ) : null;
  if (row.book === 'finished') {
    const caption = row.item ? lineConfigLabel(row.item.configuration, 'product', t) : '';
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

/** Order · customer · note — a server note is a token and is translated; an operator's is verbatim. */
function JournalContext({ row }: { row: StockJournalRow }) {
  const { t } = useTranslation();
  const note = row.note ? (isNoteToken(row.note) ? t(`stock.note.${row.note}`) : row.note) : null;
  const bits = [
    row.project ? (
      <Link key="order" to={`/projects/${row.project.id}`} className="text-bambu-green hover:underline">
        {row.project.code}
      </Link>
    ) : null,
    row.customer ? <span key="customer">{row.customer.name}</span> : null,
    note ? <span key="note" className="text-bambu-gray">{note}</span> : null,
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
