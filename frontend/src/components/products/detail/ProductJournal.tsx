import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../../api/client';
import type { StockJournalBook } from '../../../api/client';
import { useStockJournalPage } from '../../../hooks/useFinishedStock';
import type { DateFormat, TimeFormat } from '../../../utils/date';
import { answeredEmpty, listState } from '../../../utils/listState';
import { PaginationBar } from '../../PaginationBar';
import { JournalTable } from '../../stock/StockJournal';
import { LoadFailedNote } from '../../workshop/LoadFailedNote';
import { RefreshFailedNote } from '../../workshop/RefreshFailedNote';

const BOOKS: StockJournalBook[] = ['both', 'finished', 'parts'];
const PER_PAGE = 24;

/**
 * The product's movements — both ledgers, newest first, in numbered pages of 24 (WS-13 E9
 * F03, R04, R12). The product is a fixed filter: no product picker, no catalog read; the
 * only choice is the ledger, and choosing one goes back to page 1.
 *
 * States are `listState`'s, the lists' agreed contract (E7 / E8): the previous page stays
 * on screen only while the next is on its way. A new page or ledger that failed is an
 * alert with a retry that asks for THAT page and ledger again — none of the previous
 * key's rows and none of its page bar under the new number, and the failure never moves
 * the page. A re-read of a key that has its own answer and failed keeps that answer (an
 * empty one too) under a note. A page past the end is normalised only by an answer of
 * its own key.
 */
export function ProductJournal({ productId }: { productId: number }) {
  const { t } = useTranslation();
  const [book, setBook] = useState<StockJournalBook>('both');
  const [page, setPage] = useState(1);
  const journal = useStockJournalPage({ product_id: productId, book, page, per_page: PER_PAGE, sort_by: 'date-desc' });
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings, staleTime: 60_000 });
  const dateFormat = (settings?.date_format || 'system') as DateFormat;
  const timeFormat = (settings?.time_format || 'system') as TimeFormat;

  const answer = journal.data?.meta ? { meta: journal.data.meta } : undefined;
  const state = listState({ data: answer, isError: journal.isError, isPlaceholderData: journal.isPlaceholderData });
  const meta = journal.data?.meta;

  useEffect(() => {
    if (meta && !journal.isPlaceholderData && meta.last_page >= 1 && page > meta.last_page) setPage(meta.last_page);
  }, [meta, journal.isPlaceholderData, page]);

  let body;
  if (state === 'loading') {
    body = (
      <div data-testid="journal-skeleton" aria-busy="true" className="space-y-2 animate-pulse">
        <span className="sr-only" role="status">
          {t('common.loading')}
        </span>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-8 rounded bg-bambu-dark-tertiary/60" />
        ))}
      </div>
    );
  } else if (state === 'failed') {
    body = <LoadFailedNote message={t('products.detail.stockTab.journalFailed')} onRetry={() => journal.refetch()} />;
  } else {
    const rows = journal.data?.items ?? [];
    body = (
      <div className={state === 'transition' ? 'opacity-60' : undefined} aria-busy={state === 'transition' || undefined}>
        {state === 'refresh-failed' && <RefreshFailedNote onRetry={() => journal.refetch()} />}
        {answeredEmpty(state, answer) || rows.length === 0 ? (
          <p className="text-sm text-bambu-gray">
            {t(book === 'both' ? 'products.detail.stockTab.journalEmpty' : 'products.detail.stockTab.journalEmptyBook')}
          </p>
        ) : (
          <div className="space-y-0">
            <JournalTable
              rows={rows}
              dateFormat={dateFormat}
              timeFormat={timeFormat}
              scope="product"
              label={t('products.detail.stockTab.journal')}
            />
            {meta && (
              <PaginationBar
                page={meta.current_page}
                totalPages={meta.last_page}
                perPage={PER_PAGE}
                total={meta.total}
                onPageChange={setPage}
                onPerPageChange={() => {}}
                perPageOptions={[PER_PAGE]}
                allowAll={false}
                items={t('products.detail.stockTab.movements', { count: meta.total })}
                variant="bare"
              />
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <section data-testid="product-journal" className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold text-white">{t('products.detail.stockTab.journal')}</h3>
        <div role="group" aria-label={t('products.detail.stockTab.book')} className="inline-flex rounded-lg border border-bambu-dark-tertiary p-0.5">
          {BOOKS.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={book === value}
              onClick={() => {
                if (value === book) return;
                setBook(value);
                setPage(1);
              }}
              className={`rounded-md px-3 py-1 text-sm transition-colors ${
                book === value ? 'bg-bambu-dark-tertiary text-white' : 'text-bambu-gray hover:text-white'
              }`}
            >
              {t(`products.detail.stockTab.books.${value}`)}
            </button>
          ))}
        </div>
      </div>
      {body}
    </section>
  );
}
