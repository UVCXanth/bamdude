import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDispatchNotes } from '../../hooks/useDispatchNotes';
import { PaginationBar } from '../PaginationBar';
import { DispatchNotesTable } from './DispatchNotesTable';

const PER_PAGE = 20;

/**
 * «Видачі» — a customer's or an order's dispatch notes, one server page at a time
 * (spec workshop-dispatch-notes, rules 21–22). An order's empty section is not drawn.
 */
export function DispatchNotesSection({
  customerId,
  projectId,
  canEdit,
  hideWhenEmpty = false,
}: {
  customerId?: number;
  projectId?: number;
  canEdit: boolean;
  hideWhenEmpty?: boolean;
}) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(PER_PAGE);
  const [sort, setSort] = useState('created-desc');
  const filter = customerId != null ? { customer_id: customerId } : { project_id: projectId };
  const { data, isLoading } = useDispatchNotes({ ...filter, sort_by: sort, page, per_page: perPage });

  if (isLoading) return null;
  const items = data?.items ?? [];
  if (hideWhenEmpty && items.length === 0) return null;

  return (
    <section className="space-y-3" data-testid="dispatch-notes-section">
      <h2 className="text-lg font-medium text-white">{t('stock.notes.sectionTitle')}</h2>
      {items.length === 0 ? (
        <p className="text-bambu-gray text-sm">{t('stock.notes.empty')}</p>
      ) : (
        <DispatchNotesTable
          items={items}
          sort={sort}
          onSortChange={(next) => {
            setSort(next);
            setPage(1);
          }}
          canEdit={canEdit}
          hideCustomer={customerId != null}
          hideOrder={projectId != null}
        />
      )}
      {data && items.length > 0 && (
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
          variant="bare"
        />
      )}
    </section>
  );
}
