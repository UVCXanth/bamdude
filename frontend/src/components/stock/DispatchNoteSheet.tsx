import { useTranslation } from 'react-i18next';
import type { DispatchNote } from '../../api/client';
import { lineConfigLabel } from '../projects/lineConfigLabel';
import { parseUTCDate } from '../../utils/date';

const CELL = 'border border-gray-400 px-2 py-1.5';

/**
 * The dispatch note as paper (spec workshop-dispatch-notes, rule 19). ⚠️ The ONE place in
 * the app with colours of its own: a white sheet in any theme, on screen and in print — the
 * owner's decision (WS-12, decision 3). Drawn only from the snapshot. `data-print-sheet`
 * is what the print stylesheet (`index.css`) keeps when everything else is hidden.
 */
export function DispatchNoteSheet({ note }: { note: DispatchNote }) {
  const { t, i18n } = useTranslation();
  const date = parseUTCDate(note.created_at);
  const dated = date
    ? date.toLocaleDateString(i18n.language === 'uk' ? 'uk-UA' : 'en-GB', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      })
    : '';
  const s = note.supplier;
  const supplierBits = [
    s.address,
    s.phone,
    s.code && `${t('stock.dispatchNote.codeLabel')}: ${s.code}`,
    s.iban && `${t('stock.dispatchNote.iban')}: ${s.iban}`,
  ].filter(Boolean) as string[];
  const recipientBits = [note.recipient_name, note.recipient_phone].filter(Boolean).join(' · ');
  const deliveryBits = [note.delivery_method, note.delivery_details].filter(Boolean).join(' · ');
  const headers: [string, string][] = [
    ['no', 'text-left'],
    ['item', 'text-left'],
    ['sku', 'text-left'],
    ['configuration', 'text-left'],
    ['unit', 'text-left'],
    ['quantity', 'text-right'],
  ];

  return (
    <article
      data-testid="dispatch-note-sheet"
      data-print-sheet
      className="mx-auto max-w-[920px] rounded-xl bg-white p-8 text-sm text-gray-900 shadow-lg print:max-w-none print:rounded-none print:p-0 print:shadow-none"
    >
      <header className="flex items-start justify-between gap-4 border-b-2 border-gray-900 pb-4 mb-4">
        <div>
          <div className="text-xl font-semibold">{t('stock.dispatchNote.heading', { code: note.code })}</div>
          <div className="text-gray-600">{t('stock.dispatchNote.dated', { date: dated })}</div>
        </div>
        <div className="text-right font-semibold">{s.name || '—'}</div>
      </header>

      <div className="grid grid-cols-3 gap-4 mb-4">
        <div data-testid="dispatch-note-supplier">
          <div className="text-xs text-gray-600">{t('stock.dispatchNote.supplier')}</div>
          <div className="font-semibold">{s.name || '—'}</div>
          {supplierBits.map((bit) => (
            <div key={bit} className="text-gray-600">
              {bit}
            </div>
          ))}
        </div>
        <div>
          <div className="text-xs text-gray-600">{t('stock.dispatchNote.recipient')}</div>
          <div className="font-semibold">{note.customer_name || '—'}</div>
          {recipientBits && <div className="text-gray-600">{recipientBits}</div>}
          {deliveryBits && <div className="text-gray-600">{deliveryBits}</div>}
          {note.waybill && (
            <div className="text-gray-600">{t('stock.dispatchNote.waybill', { waybill: note.waybill })}</div>
          )}
        </div>
        <div>
          <div className="text-xs text-gray-600">{t('stock.dispatchNote.basis')}</div>
          <div className="font-semibold">
            {note.order_code
              ? t('stock.dispatchNote.basisOrder', { code: note.order_code })
              : t('stock.dispatchNote.basisStock')}
          </div>
          {note.order_name && <div className="text-gray-600">{note.order_name}</div>}
        </div>
      </div>

      <table className="w-full border-collapse">
        <thead>
          <tr>
            {headers.map(([key, align]) => (
              <th key={key} className={`${CELL} bg-gray-100 font-semibold ${align}`}>
                {t(`stock.dispatchNote.${key}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {note.lines.map((line) => (
            <tr key={line.position}>
              <td className={CELL}>{line.position}</td>
              <td className={CELL}>
                {line.part_name
                  ? t('stock.notes.partOf', { part: line.part_name, product: line.product_name })
                  : line.product_name}
              </td>
              <td className={CELL}>{line.sku || '—'}</td>
              <td className={CELL}>
                {(line.part_name ? '' : lineConfigLabel(line.configuration, 'product', t)) || '—'}
              </td>
              <td className={CELL}>{t('stock.dispatchNote.pcs')}</td>
              <td className={`${CELL} text-right tabular-nums`}>{line.quantity}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="font-semibold">
            <td colSpan={5} className={CELL}>
              {t('stock.dispatchNote.totalItems', { count: note.lines.length })}
            </td>
            <td data-testid="dispatch-note-total" className={`${CELL} text-right tabular-nums`}>
              {note.units}
            </td>
          </tr>
        </tfoot>
      </table>

      {note.note && <p className="mt-4 text-gray-600">{note.note}</p>}

      <div className="grid grid-cols-2 gap-8 mt-10">
        {(
          [
            ['issuedBy', note.created_by_name ?? ''],
            ['receivedBy', ''],
          ] as const
        ).map(([key, who]) => (
          <div key={key} className="flex items-end gap-2">
            <span>{t(`stock.dispatchNote.${key}`)}</span>
            {who && <span className="font-medium">{who}</span>}
            <span className="h-5 flex-1 border-b border-gray-900" />
          </div>
        ))}
      </div>
    </article>
  );
}
