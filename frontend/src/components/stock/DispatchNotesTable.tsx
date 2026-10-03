import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { FileText } from 'lucide-react';
import { api } from '../../api/client';
import type { StockIssueRow } from '../../api/client';
import { SortableHeader } from '../SortableHeader';
import { CONFIG_ACCENT_CLASS, isNonStandardConfiguration, lineConfigLabel } from '../projects/lineConfigLabel';
import { formatDateTime } from '../../utils/date';
import type { DateFormat, TimeFormat } from '../../utils/date';
import { WorkshopPanel, WorkshopTableScroll } from '../workshop/WorkshopPanel';
import { WaybillEditor } from './WaybillEditor';

/**
 * Dispatch notes — one table for the stock tab, an order's «Issues» and a customer's
 * (spec workshop-dispatch-notes, rules 20–22; WS-13 E12 J01): the mockup's eight columns —
 * the note with its waybill under it, the date and time, the recipient (the customer and,
 * small, the person), the order, what was issued, the quantity, who issued it and «Open».
 *
 * Rows are the server's page and the headers ask the SERVER to sort. What was issued is the
 * snapshot's summary (at most three lines): a product with its configuration beside it in
 * the order lines' accent — the standard is not written — or a part «for» its product;
 * «+N more» counts the note's lines, not the summary's.
 */
export function DispatchNotesTable({
  items,
  sort,
  onSortChange,
  canEdit,
  hideCustomer = false,
  hideOrder = false,
  footer,
  onWaybillSaved,
}: {
  items: StockIssueRow[];
  sort: string;
  onSortChange: (sortBy: string) => void;
  canEdit: boolean;
  hideCustomer?: boolean;
  hideOrder?: boolean;
  /** The page bar, inside the panel under the rows (outside the scroll). */
  footer?: ReactNode;
  /** A waybill was saved — the list watches whether its row leaves (J03). */
  onWaybillSaved?: (pencil: HTMLButtonElement | null) => void;
}) {
  const { t } = useTranslation();
  // The server sends naive UTC; the app's formatter reads it as such and follows the settings.
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings, staleTime: 60_000 });
  const timeFormat = (settings?.time_format ?? 'system') as TimeFormat;
  const dateFormat = (settings?.date_format ?? 'system') as DateFormat;
  const plain = (label: string) => <th className="font-normal p-2 text-left">{label}</th>;

  return (
    <WorkshopPanel flush footer={footer}>
      <WorkshopTableScroll label={t('stock.tabs.notes')}>
        <table className="w-full text-sm">
          <thead className="text-xs text-bambu-gray bg-bambu-dark-secondary">
            <tr>
              <SortableHeader sortKey="code" label={t('stock.notes.code')} sort={sort} onSort={onSortChange} descFirst />
              <SortableHeader sortKey="created" label={t('stock.notes.date')} sort={sort} onSort={onSortChange} descFirst />
              {!hideCustomer && (
                <SortableHeader sortKey="customer" label={t('stock.notes.recipient')} sort={sort} onSort={onSortChange} />
              )}
              {!hideOrder && plain(t('stock.notes.order'))}
              {plain(t('stock.notes.what'))}
              <SortableHeader
                sortKey="units"
                label={t('stock.notes.units')}
                sort={sort}
                onSort={onSortChange}
                descFirst
                align="right"
              />
              {plain(t('stock.notes.by'))}
              <th className="p-2" aria-label={t('common.actions')} />
            </tr>
          </thead>
          <tbody>
            {items.map((note) => {
              const more = note.lines_count - note.summary.length;
              return (
                <tr key={note.id} className="border-t border-bambu-dark-tertiary text-white align-top" data-testid={`note-${note.id}`}>
                  <td className="p-2 whitespace-nowrap">
                    <Link to={`/stock/dispatch-notes/${note.id}`} className="text-bambu-green hover:underline">
                      {note.code}
                    </Link>
                    <WaybillEditor noteId={note.id} waybill={note.waybill} canEdit={canEdit} onSaved={onWaybillSaved} />
                  </td>
                  <td className="p-2 whitespace-nowrap text-bambu-gray">
                    <small className="text-xs">{formatDateTime(note.created_at, timeFormat, dateFormat)}</small>
                  </td>
                  {!hideCustomer && (
                    <td className="p-2">
                      {note.customer_id != null ? (
                        <Link to={`/customers/${note.customer_id}`} className="hover:underline">
                          {note.customer_name}
                        </Link>
                      ) : (
                        note.customer_name
                      )}
                      {note.recipient_name && <small className="block text-xs text-bambu-gray">{note.recipient_name}</small>}
                    </td>
                  )}
                  {!hideOrder && (
                    <td className="p-2 whitespace-nowrap">
                      {note.project_id != null && note.order_code ? (
                        <Link to={`/projects/${note.project_id}`} className="hover:underline">
                          {note.order_code}
                        </Link>
                      ) : (
                        <small className="text-xs text-bambu-gray">{note.order_code ?? t('stock.notes.noOrder')}</small>
                      )}
                    </td>
                  )}
                  <td className="p-2" data-testid={`note-${note.id}-lines`}>
                    {note.summary.map((line, i) => {
                      if (line.part_name) {
                        return (
                          <span key={i} data-line className="block">
                            {`${t('stock.notes.partOf', { part: line.part_name, product: line.product_name })} × ${line.quantity}`}
                          </span>
                        );
                      }
                      const caption = isNonStandardConfiguration(line.configuration)
                        ? lineConfigLabel(line.configuration ?? undefined, 'product', t)
                        : '';
                      return (
                        <span key={i} data-line className="block">
                          {line.product_name}
                          {caption && (
                            <>
                              {' '}
                              <span data-config-accent className={CONFIG_ACCENT_CLASS}>
                                {caption}
                              </span>
                            </>
                          )}
                          {` × ${line.quantity}`}
                        </span>
                      );
                    })}
                    {more > 0 && <span className="block text-xs text-bambu-gray">{t('stock.notes.more', { count: more })}</span>}
                  </td>
                  <td className="p-2 text-right tabular-nums">{note.units}</td>
                  <td className="p-2 text-bambu-gray">{note.created_by_name ?? ''}</td>
                  <td className="p-2 text-right">
                    <Link
                      to={`/stock/dispatch-notes/${note.id}`}
                      aria-label={`${t('stock.notes.open')} ${note.code}`}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded text-sm text-bambu-gray hover:text-white hover:bg-bambu-dark-tertiary"
                    >
                      <FileText className="w-4 h-4" aria-hidden />
                      {t('stock.notes.open')}
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </WorkshopTableScroll>
    </WorkshopPanel>
  );
}
