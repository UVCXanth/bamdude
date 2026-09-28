import { Link, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Loader2, Printer } from 'lucide-react';
import { Button } from '../../components/Button';
import { DispatchNoteSheet } from '../../components/stock/DispatchNoteSheet';
import { useDispatchNote } from '../../hooks/useDispatchNotes';

/** `/stock/dispatch-notes/:id` — the note, and «Print» (spec workshop-dispatch-notes, rule 19). */
export function DispatchNotePage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const { data: note, isLoading } = useDispatchNote(Number(id));

  if (isLoading) {
    return (
      <p className="p-4 flex items-center gap-2 text-sm text-bambu-gray">
        <Loader2 className="w-4 h-4 animate-spin" />
        {t('common.loading')}
      </p>
    );
  }
  if (!note) return <p className="p-4 text-sm text-bambu-gray">{t('stock.dispatchNote.notFound')}</p>;

  return (
    <div className="p-4 print:p-0">
      <div data-testid="dispatch-note-controls" className="print:hidden mb-4 space-y-2">
        <nav className="text-sm text-bambu-gray">
          <Link to="/stock?tab=notes" className="hover:text-white">
            {t('stock.tabs.notes')}
          </Link>
          <span> › {note.code}</span>
        </nav>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold text-white">{t('stock.dispatchNote.title', { code: note.code })}</h1>
            <p className="text-sm text-bambu-gray flex gap-2 flex-wrap">
              {note.project_id != null && note.order_code && (
                <Link to={`/projects/${note.project_id}`} className="text-bambu-green hover:underline">
                  {note.order_code}
                  {note.order_name ? ` · ${note.order_name}` : ''}
                </Link>
              )}
              {note.customer_id != null && (
                <Link to={`/customers/${note.customer_id}`} className="text-bambu-green hover:underline">
                  {note.customer_name}
                </Link>
              )}
            </p>
          </div>
          <Button onClick={() => window.print()}>
            <Printer className="w-4 h-4" />
            {t('stock.dispatchNote.print')}
          </Button>
        </div>
      </div>
      <DispatchNoteSheet note={note} />
    </div>
  );
}
