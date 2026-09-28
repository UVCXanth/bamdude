import type { ReactNode } from 'react';
import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Check, Pencil, X } from 'lucide-react';
import { api, WAYBILL_MAX } from '../../api/client';
import type { StockIssueRow } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { SortableHeader } from '../SortableHeader';
import { formatDateTime } from '../../utils/date';
import type { DateFormat, TimeFormat } from '../../utils/date';

const ICON_BTN = 'p-1 rounded text-bambu-gray hover:text-white hover:bg-bambu-dark transition-colors';

/**
 * Dispatch notes — one table for the stock tab, an order's «Видачі» and a customer's
 * issues (spec workshop-dispatch-notes, rules 20–22). Rows are the server's page and
 * the headers ask the SERVER to sort; the waybill is written in the row afterwards.
 */
export function DispatchNotesTable({
  items,
  sort,
  onSortChange,
  canEdit,
  hideCustomer = false,
  hideOrder = false,
  footer,
}: {
  items: StockIssueRow[];
  sort: string;
  onSortChange: (sortBy: string) => void;
  canEdit: boolean;
  hideCustomer?: boolean;
  hideOrder?: boolean;
  footer?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-bambu-gray">
            <SortableHeader sortKey="code" label={t('stock.notes.code')} sort={sort} onSort={onSortChange} descFirst />
            <SortableHeader sortKey="created" label={t('stock.notes.date')} sort={sort} onSort={onSortChange} descFirst />
            {!hideCustomer && (
              <SortableHeader sortKey="customer" label={t('stock.notes.customer')} sort={sort} onSort={onSortChange} />
            )}
            {!hideOrder && <th className="font-normal p-2">{t('stock.notes.order')}</th>}
            <th className="font-normal p-2">{t('stock.notes.what')}</th>
            <SortableHeader
              sortKey="units"
              label={t('stock.notes.units')}
              sort={sort}
              onSort={onSortChange}
              descFirst
              align="right"
            />
            <th className="font-normal p-2">{t('stock.notes.waybill')}</th>
            <th className="font-normal p-2">{t('stock.notes.by')}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((note) => (
            <NoteRow key={note.id} note={note} canEdit={canEdit} hideCustomer={hideCustomer} hideOrder={hideOrder} />
          ))}
        </tbody>
      </table>
      {footer}
    </div>
  );
}

function NoteRow({
  note,
  canEdit,
  hideCustomer,
  hideOrder,
}: {
  note: StockIssueRow;
  canEdit: boolean;
  hideCustomer: boolean;
  hideOrder: boolean;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { showToast } = useToast();
  const [editing, setEditing] = useState<string | null>(null);
  // The server sends naive UTC; the app's formatter reads it as such and follows the settings.
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings, staleTime: 60_000 });
  const timeFormat = (settings?.time_format ?? 'system') as TimeFormat;
  const dateFormat = (settings?.date_format ?? 'system') as DateFormat;

  const save = useMutation({
    mutationFn: (waybill: string) => api.updateStockIssue(note.id, { waybill: waybill.trim() || null }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dispatch-notes'] });
      qc.invalidateQueries({ queryKey: ['dispatch-note', note.id] });
      setEditing(null);
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  const shown = note.summary.map((line) =>
    line.part_name
      ? `${t('stock.notes.partOf', { part: line.part_name, product: line.product_name })} × ${line.quantity}`
      : `${line.product_name} × ${line.quantity}`,
  );
  const more = note.lines_count - note.summary.length;

  return (
    <tr className="border-t border-bambu-dark-tertiary text-white" data-testid={`note-${note.id}`}>
      <td className="p-2 whitespace-nowrap">
        <Link to={`/stock/dispatch-notes/${note.id}`} className="text-bambu-green hover:underline">
          {note.code}
        </Link>
      </td>
      <td className="p-2 whitespace-nowrap text-bambu-gray">{formatDateTime(note.created_at, timeFormat, dateFormat)}</td>
      {!hideCustomer && (
        <td className="p-2">
          {note.customer_id != null ? (
            <Link to={`/customers/${note.customer_id}`} className="hover:underline">
              {note.customer_name}
            </Link>
          ) : (
            note.customer_name
          )}
        </td>
      )}
      {!hideOrder && (
        <td className="p-2 whitespace-nowrap">
          {note.project_id != null && note.order_code ? (
            <Link to={`/projects/${note.project_id}`} className="hover:underline">
              {note.order_code}
            </Link>
          ) : (
            <span className="text-bambu-gray">{note.order_code ?? t('stock.notes.noOrder')}</span>
          )}
        </td>
      )}
      <td className="p-2">
        {shown.map((text, i) => (
          <div key={`${i}-${text}`}>{text}</div>
        ))}
        {more > 0 && <div className="text-bambu-gray">{t('stock.notes.more', { count: more })}</div>}
      </td>
      <td className="p-2 text-right tabular-nums">{note.units}</td>
      <td className="p-2">
        {editing != null ? (
          <span className="flex items-center gap-1">
            <input
              value={editing}
              maxLength={WAYBILL_MAX}
              onChange={(e) => setEditing(e.target.value)}
              aria-label={t('stock.notes.waybill')}
              className="w-44 px-2 py-1 bg-bambu-dark border border-bambu-dark-tertiary rounded text-white"
            />
            <button
              type="button"
              onClick={() => save.mutate(editing)}
              disabled={save.isPending}
              aria-label={t('common.save')}
              title={t('common.save')}
              className={ICON_BTN}
            >
              <Check className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => setEditing(null)}
              aria-label={t('common.cancel')}
              title={t('common.cancel')}
              className={ICON_BTN}
            >
              <X className="w-4 h-4" />
            </button>
          </span>
        ) : (
          <span className="flex items-center gap-1">
            <span className="tabular-nums">{note.waybill ?? ''}</span>
            {canEdit && (
              <button
                type="button"
                onClick={() => setEditing(note.waybill ?? '')}
                aria-label={t('stock.notes.editWaybill')}
                title={t('stock.notes.editWaybill')}
                className={ICON_BTN}
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
            )}
          </span>
        )}
      </td>
      <td className="p-2 text-bambu-gray">{note.created_by_name ?? ''}</td>
    </tr>
  );
}
