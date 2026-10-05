import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../contexts/AuthContext';
import type { DispatchNotesParams } from '../../api/client';
import { useDispatchNotes } from '../../hooks/useDispatchNotes';
import { listState } from '../../utils/listState';
import { DispatchNotesList } from './DispatchNotesList';

// One of PaginationBar's own sizes, so its select shows it (final review M8).
const PER_PAGE = 24;

/**
 * «Видачі» — a customer's or an order's dispatch notes, one server page at a time
 * (spec workshop-dispatch-notes, rules 21–22), through the one list of the three places
 * (WS-13 E12 J02, `DispatchNotesList`); the section owns its page, size and sort in memory
 * and keys them by its owner, so another customer starts on the first page.
 *
 * `inTab` — the order page's «Issues» tab (WS-13 E3 F05, R04): the tab names it, so no
 * heading; and a tab never stands blank, so the empty list says where issues come from
 * (E4 G02). Without it — the customer's page — the page names the section (`title`,
 * `caption`), and its heading is where the focus goes when a row leaves.
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
  // The waybill is the stock's (`PATCH /stock-issues` asks `stock:move`, WS-13 E13 O25),
  // whatever the page that shows the notes may edit.
  const { hasPermission } = useAuth();
  const editable = canEdit && hasPermission('stock:move');
  const heading = useRef<HTMLHeadingElement>(null);
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(PER_PAGE);
  const [sort, setSort] = useState('created-desc');
  const filter = customerId != null ? { customer_id: customerId } : { project_id: projectId };
  const params: DispatchNotesParams = { ...filter, sort_by: sort, page, per_page: perPage };
  // The same key the list reads — one request — asked here only to know whether an
  // order's section that may be empty is drawn at all.
  const probe = useDispatchNotes(params, hideWhenEmpty);
  const probeState = listState({ data: probe.data, isError: probe.isError, isPlaceholderData: probe.isPlaceholderData });
  if (hideWhenEmpty && (probeState === 'loading' || probeState === 'empty')) return null;

  const list = (
    <DispatchNotesList
      params={params}
      sort={sort}
      onSortChange={(next) => {
        setSort(next);
        setPage(1);
      }}
      perPage={perPage}
      onPageChange={setPage}
      onPerPageChange={(n) => {
        setPerPage(n);
        setPage(1);
      }}
      canEdit={editable}
      hideCustomer={customerId != null}
      hideOrder={projectId != null}
      fallbackRef={inTab ? undefined : heading}
      empty={
        inTab ? (
          // WS-13 E4 G02: the order's tab says where issues come from.
          <div className="py-8 text-center">
            <p className="text-sm font-medium text-white">{t('stock.notes.orderEmptyTitle')}</p>
            <p className="mt-1 text-sm text-bambu-gray">{t('stock.notes.orderEmptyText')}</p>
          </div>
        ) : (
          <p className="text-sm text-bambu-gray">{t('stock.notes.empty')}</p>
        )
      }
    />
  );

  return (
    <section className="space-y-3" data-testid="dispatch-notes-section">
      {!inTab && (
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <h2 ref={heading} tabIndex={-1} className="text-lg font-medium text-white outline-none">
            {title ?? t('stock.notes.sectionTitle')}
          </h2>
          {caption && <small className="text-xs text-bambu-gray">{caption}</small>}
        </div>
      )}
      {list}
    </section>
  );
}
