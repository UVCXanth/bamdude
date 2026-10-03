import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDispatchNotes } from '../../hooks/useDispatchNotes';
import { answeredEmpty, listState } from '../../utils/listState';
import { Button } from '../Button';
import { PaginationBar } from '../PaginationBar';
import { LoadFailedNote } from '../workshop/LoadFailedNote';
import { RefreshFailedNote } from '../workshop/RefreshFailedNote';
import { WorkshopPanel } from '../workshop/WorkshopPanel';
import { DispatchNotesTable } from './DispatchNotesTable';

// One of PaginationBar's own sizes, so its select shows it (final review M8).
const PER_PAGE = 24;

/**
 * «Видачі» — a customer's or an order's dispatch notes, one server page at a time
 * (spec workshop-dispatch-notes, rules 21–22). An order's empty section is not drawn.
 *
 * `inTab` — the order page's «Issues» tab (WS-13 E3 F05, R04): the tab names it,
 * so no heading; and a tab never stands blank, so the wait and the empty list are
 * said in words.
 *
 * Without it — the customer's page — the section reads by the key on screen (WS-13 E11
 * E08, R02, `listState`): the first read says it is reading; a page on its way keeps the
 * previous page of THIS owner dimmed (the hook never hands another owner's answer); a key
 * that failed is an alert with its retry and no rows or pages of another key; a failed
 * re-read keeps its own answer, an empty one too, with a note. The page is brought back to
 * the last one only by an answer of its own key. The page names the section (`title`,
 * `caption`) and keys it by its owner, so another customer starts on the first page.
 */
export function DispatchNotesSection({
  customerId,
  projectId,
  canEdit,
  hideWhenEmpty = false,
  inTab = false,
  title,
  caption,
}: {
  customerId?: number;
  projectId?: number;
  canEdit: boolean;
  hideWhenEmpty?: boolean;
  inTab?: boolean;
  title?: string;
  caption?: string;
}) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(PER_PAGE);
  const [sort, setSort] = useState('created-desc');
  const filter = customerId != null ? { customer_id: customerId } : { project_id: projectId };
  const { data, isLoading, isError, isPlaceholderData, refetch } = useDispatchNotes({
    ...filter,
    sort_by: sort,
    page,
    per_page: perPage,
  });
  // Only an answer of THIS key knows how many pages there are now.
  useEffect(() => {
    if (data && !isPlaceholderData && data.meta.last_page >= 1 && page > data.meta.last_page) {
      setPage(data.meta.last_page);
    }
  }, [data, isPlaceholderData, page]);

  const onSortChange = (next: string) => {
    setSort(next);
    setPage(1);
  };
  const pages = (variant: 'card' | 'bare') =>
    data ? (
      <PaginationBar
        page={page}
        totalPages={data.meta.last_page}
        perPage={perPage}
        total={data.meta.total}
        onPageChange={setPage}
        onPerPageChange={(n) => {
          setPerPage(n);
          setPage(1);
        }}
        items={t('stock.notes.items')}
        variant={variant}
      />
    ) : null;

  if (!inTab) {
    const state = listState({ data, isError, isPlaceholderData });
    const emptyAnswer = answeredEmpty(state, data);
    // An order's section that may be empty is not drawn until it is known not to be.
    if (hideWhenEmpty && (state === 'loading' || state === 'empty')) return null;
    return (
      <section className="space-y-3" data-testid="dispatch-notes-section">
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <h2 className="text-lg font-medium text-white">{title ?? t('stock.notes.sectionTitle')}</h2>
          {caption && <small className="text-xs text-bambu-gray">{caption}</small>}
        </div>
        <WorkshopPanel flush footer={data && !emptyAnswer && state !== 'failed' ? pages('card') : undefined}>
          {state === 'loading' && <p className="p-4 text-sm text-bambu-gray">{t('common.loading')}</p>}
          {state === 'failed' && (
            <div className="p-4">
              <LoadFailedNote message={t('stock.notes.error')} onRetry={() => refetch()} />
            </div>
          )}
          {state === 'refresh-failed' && (
            <div className="px-4 pt-3">
              <RefreshFailedNote onRetry={() => void refetch()} />
            </div>
          )}
          {emptyAnswer && <p className="p-4 text-sm text-bambu-gray">{t('stock.notes.empty')}</p>}
          {data && !emptyAnswer && (
            <div
              data-testid="dispatch-notes-body"
              aria-busy={isPlaceholderData}
              className={`transition-opacity ${isPlaceholderData ? 'opacity-60' : ''}`}
            >
              <DispatchNotesTable
                items={data.items}
                sort={sort}
                onSortChange={onSortChange}
                canEdit={canEdit}
                hideCustomer={customerId != null}
                hideOrder={projectId != null}
              />
            </div>
          )}
        </WorkshopPanel>
      </section>
    );
  }

  if (isLoading) return <p className="text-sm text-bambu-gray">{t('common.loading')}</p>;
  // In the order's tab a list that could not be read is not an empty one (review 7).
  if (isError && !data) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm text-red-400">
        <span>{t('stock.notes.error')}</span>
        <Button size="sm" variant="secondary" onClick={() => void refetch()}>
          {t('common.retry')}
        </Button>
      </div>
    );
  }
  const items = data?.items ?? [];

  return (
    <section className="space-y-3" data-testid="dispatch-notes-section">
      {isError && <RefreshFailedNote onRetry={() => void refetch()} />}
      {items.length === 0 ? (
        // WS-13 E4 G02: the order's tab says where issues come from.
        <div className="py-8 text-center">
          <p className="text-sm font-medium text-white">{t('stock.notes.orderEmptyTitle')}</p>
          <p className="mt-1 text-sm text-bambu-gray">{t('stock.notes.orderEmptyText')}</p>
        </div>
      ) : (
        <DispatchNotesTable
          items={items}
          sort={sort}
          onSortChange={onSortChange}
          canEdit={canEdit}
          hideCustomer={customerId != null}
          hideOrder={projectId != null}
        />
      )}
      {data && items.length > 0 && pages('bare')}
    </section>
  );
}
