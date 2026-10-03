import { Fragment } from 'react';
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Printer } from 'lucide-react';
import { ApiError, api } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { Button } from '../../components/Button';
import { formatDateTime } from '../../utils/date';
import type { DateFormat, TimeFormat } from '../../utils/date';
import { DispatchNoteSheet } from '../../components/stock/DispatchNoteSheet';
import { WaybillEditor } from '../../components/stock/WaybillEditor';
import { LoadFailedNote } from '../../components/workshop/LoadFailedNote';
import { RefreshFailedNote } from '../../components/workshop/RefreshFailedNote';
import { WorkshopPanel, WorkshopTableScroll } from '../../components/workshop/WorkshopPanel';
import { useDispatchNote } from '../../hooks/useDispatchNotes';

/**
 * `/stock/dispatch-notes/:id` — the note (spec workshop-dispatch-notes, rule 19; WS-13 E12
 * J04): above the sheet, and not printed, the crumbs, the heading, the date · order · name ·
 * customer (linked only where they still exist), the waybill with its editor and «Print».
 * The sheet prints only when asked. A first read is a skeleton; a note that is gone says so
 * with the way back to the notes; any other failure is an alert with its retry.
 */
export function DispatchNotePage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const { hasPermission } = useAuth();
  const { data: note, error, isFetching, refetch } = useDispatchNote(Number(id));
  // The server sends naive UTC; the app's formatter reads it as such and follows the settings.
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings, staleTime: 60_000 });
  const timeFormat = (settings?.time_format ?? 'system') as TimeFormat;
  const dateFormat = (settings?.date_format ?? 'system') as DateFormat;
  const valid = Number.isInteger(Number(id)) && Number(id) > 0;

  if (!note) {
    // Only a 404 is «not found»; any other failure says it could not load (final review M4).
    if (!valid || (error instanceof ApiError && error.status === 404)) {
      return (
        <div className="workshop p-4">
          <WorkshopPanel>
            <p className="mb-2 text-base font-semibold text-white">{t('stock.dispatchNote.notFound')}</p>
            <Link to="/stock?tab=notes" className="text-sm text-bambu-green hover:underline">
              {t('stock.dispatchNote.backToNotes')}
            </Link>
          </WorkshopPanel>
        </div>
      );
    }
    if (error) {
      return (
        <div className="workshop p-4">
          <LoadFailedNote message={t('stock.dispatchNote.loadError')} onRetry={() => refetch()} />
        </div>
      );
    }
    return (
      <div className="workshop p-4">
        <div role="status" aria-busy="true" data-testid="dispatch-note-skeleton" className="space-y-4">
          <span className="sr-only">{t('common.loading')}</span>
          <div aria-hidden className="animate-pulse space-y-4">
            <div className="h-4 w-48 rounded bg-bambu-dark-tertiary" />
            <div className="h-8 w-80 rounded bg-bambu-dark-tertiary" />
            <div className="mx-auto h-96 max-w-[920px] rounded-xl bg-bambu-dark-secondary" />
          </div>
        </div>
      </div>
    );
  }

  const subtitle: ReactNode[] = [<span key="date">{formatDateTime(note.created_at, timeFormat, dateFormat)}</span>];
  if (note.order_code) {
    subtitle.push(
      note.project_id != null ? (
        <Link key="order" to={`/projects/${note.project_id}`} className="text-bambu-green hover:underline">
          {note.order_code}
        </Link>
      ) : (
        <span key="order">{note.order_code}</span>
      ),
    );
  }
  if (note.order_name) subtitle.push(<span key="name">{note.order_name}</span>);
  if (note.customer_name) {
    subtitle.push(
      note.customer_id != null ? (
        <Link key="customer" to={`/customers/${note.customer_id}`} className="text-bambu-green hover:underline">
          {note.customer_name}
        </Link>
      ) : (
        <span key="customer">{note.customer_name}</span>
      ),
    );
  }

  return (
    <div className="workshop p-4 print:p-0">
      <div data-testid="dispatch-note-controls" className="print:hidden mb-4 space-y-2">
        <nav className="flex items-center gap-1 text-sm text-bambu-gray">
          <Link to="/stock" className="hover:text-white transition-colors">
            {t('stock.page.title')}
          </Link>
          <ChevronRight className="w-4 h-4" />
          <Link to="/stock?tab=notes" className="hover:text-white transition-colors">
            {t('stock.tabs.notes')}
          </Link>
          <ChevronRight className="w-4 h-4" />
          <span className="text-white">{note.code}</span>
        </nav>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0 space-y-1">
            <h1 className="text-2xl font-semibold text-white break-words">{t('stock.dispatchNote.title', { code: note.code })}</h1>
            <p data-testid="dispatch-note-subtitle" className="text-sm text-bambu-gray">
              {subtitle.map((bit, i) => (
                <Fragment key={i}>
                  {i > 0 && ' · '}
                  {bit}
                </Fragment>
              ))}
            </p>
            <WaybillEditor noteId={note.id} waybill={note.waybill} canEdit={hasPermission('projects:update')} />
          </div>
          <Button onClick={() => window.print()}>
            <Printer className="w-4 h-4" />
            {t('stock.dispatchNote.print')}
          </Button>
        </div>
        {/* A re-read that failed keeps the note and says so (K; final review M5) — never on paper. */}
        {error && !isFetching && <RefreshFailedNote onRetry={() => void refetch()} />}
      </div>
      {/* A narrow screen scrolls the sheet in a region of its own, never the page (E12 pilot at
          390 px); on paper every container around the sheet gives its scrolling up (index.css). */}
      <WorkshopTableScroll label={t('stock.dispatchNote.title', { code: note.code })}>
        <DispatchNoteSheet note={note} />
      </WorkshopTableScroll>
    </div>
  );
}
