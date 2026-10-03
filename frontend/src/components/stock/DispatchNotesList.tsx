import { useEffect, useRef } from 'react';
import type { ReactNode, RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import type { DispatchNotesParams } from '../../api/client';
import { useDispatchNotes } from '../../hooks/useDispatchNotes';
import { StockTableSkeleton } from './StockTableSkeleton';
import { useFocusWhenRowLeaves } from '../../hooks/useFocusWhenRowLeaves';
import { answeredEmpty, listState } from '../../utils/listState';
import { PaginationBar } from '../PaginationBar';
import { LoadFailedNote } from '../workshop/LoadFailedNote';
import { RefreshFailedNote } from '../workshop/RefreshFailedNote';
import { DispatchNotesTable } from './DispatchNotesTable';

/**
 * One list of dispatch notes for three places (WS-13 E12 J02) — the stock page's tab, a
 * customer's section and an order's «Issues» tab: one hook (`useDispatchNotes`, whose
 * previous answer is kept only for the same owner), one table, one page bar, and what the
 * read said by the key on screen (`listState`): the first read says it is reading, a page on
 * its way keeps the previous one dimmed, a key that failed is an alert with its retry and no
 * rows or pages of another key, a failed re-read keeps its own answer — an empty one too —
 * beside a note. The page is brought back to the last one only by an answer of its own key.
 *
 * The place owns its state (the tab's URL, a section's memory) and says what an empty
 * answer means (`empty`). A saved waybill hands its pencil to a watch: when the re-read
 * takes the row away, the focus goes to `fallbackRef` — the list's stable heading.
 */
export function DispatchNotesList({
  params,
  sort,
  onSortChange,
  perPage,
  onPageChange,
  onPerPageChange,
  canEdit,
  hideCustomer = false,
  hideOrder = false,
  empty,
  fallbackRef,
}: {
  params: DispatchNotesParams;
  sort: string;
  onSortChange: (sortBy: string) => void;
  perPage: number;
  onPageChange: (page: number) => void;
  onPerPageChange: (perPage: number) => void;
  canEdit: boolean;
  hideCustomer?: boolean;
  hideOrder?: boolean;
  /** What an empty answer says in this place. */
  empty: ReactNode;
  /** The list's stable heading — the focus when a row leaves under its own save. */
  fallbackRef?: RefObject<HTMLElement | null>;
}) {
  const { t } = useTranslation();
  const noHeading = useRef<HTMLElement | null>(null);
  const watch = useFocusWhenRowLeaves(fallbackRef ?? noHeading);
  const { data, isError, isPlaceholderData, refetch } = useDispatchNotes(params);
  const state = listState({ data, isError, isPlaceholderData });
  // The empty explanation stays under a failed re-read of an empty answer (E7-V01).
  const emptyAnswer = answeredEmpty(state, data);

  // Only an answer of THIS key knows how many pages there are now.
  const meta = data && !isPlaceholderData ? data.meta : undefined;
  useEffect(() => {
    if (meta && meta.last_page >= 1 && params.page > meta.last_page) onPageChange(meta.last_page);
  }, [meta, params.page, onPageChange]);

  return (
    <>
      {/* The first read is shaped like the table that comes (B04; final review M4). */}
      {state === 'loading' && <StockTableSkeleton tab="notes" />}
      {state === 'failed' && <LoadFailedNote message={t('stock.notes.error')} onRetry={() => refetch()} />}
      {state === 'refresh-failed' && <RefreshFailedNote onRetry={() => void refetch()} />}
      {emptyAnswer && empty}
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
            hideCustomer={hideCustomer}
            hideOrder={hideOrder}
            onWaybillSaved={watch}
            footer={
              <PaginationBar
                page={data.meta.current_page}
                totalPages={data.meta.last_page}
                perPage={perPage}
                total={data.meta.total}
                onPageChange={onPageChange}
                onPerPageChange={onPerPageChange}
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
