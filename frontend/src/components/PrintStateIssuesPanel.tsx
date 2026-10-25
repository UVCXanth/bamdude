import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, type PrintStateAction, type PrintStateIssue, type PrintStateAudit } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { Card } from './Card';
import { Button } from './Button';
import { PrintStateRecoveryDialog } from './PrintStateRecoveryDialog';
import { PrintStatePreheatNote } from './PrintStateRuntimeNotes';
import { formatDateTime } from '../utils/date';

/** The anchor of a row: the stalled-start row links to the context row that holds its printer. */
const rowAnchor = (printerId: number, kind: string, target: number) => `print-state-${printerId}-${kind}-${target}`;
const LIVE_REASONS = ['live_busy', 'live_unknown'];

function RuntimeDetails({ issue }: { issue: PrintStateIssue }) {
  const { t } = useTranslation();
  const archive = issue.archive_id ?? issue.context?.archive_id ?? '—';
  const free = !issue.blocked_reasons.some(reason => LIVE_REASONS.includes(reason));
  return <div className="space-y-1">
    <p className="text-sm">{issue.code === 'terminal_runtime_context'
      ? t(free ? 'printStateRecovery.runtime.held' : 'printStateRecovery.runtime.heldBusy', { archive })
      : t('printStateRecovery.runtime.unresolved', { archive })}</p>
    {issue.age_seconds !== undefined && <p className="text-xs text-bambu-gray">{t('printStateRecovery.runtime.age', { seconds: issue.age_seconds })}</p>}
    {issue.queue_paused && <p className="text-xs text-bambu-gray">{t('printStateRecovery.runtime.paused')}</p>}
    {issue.plate_gate && <p className="text-xs text-bambu-gray">{t('printStateRecovery.runtime.plateGate')}</p>}
    <PrintStatePreheatNote pinned={issue.preheat_pinned} temperatures={issue.temperatures} />
  </div>;
}

function EpisodeDetails({ issue }: { issue: PrintStateIssue }) {
  const { t } = useTranslation();
  return <div className="space-y-1">
    <p className="text-sm">{t('printStateRecovery.episode.attempts', { count: issue.attempts ?? 0, seconds: issue.span_seconds ?? 0 })}</p>
    <p className="text-xs text-bambu-gray">{t('printStateRecovery.episode.job', { item: issue.item_id ?? '—' })}</p>
    {issue.related && <a className="text-xs text-bambu-green hover:underline"
      href={`#${rowAnchor(issue.printer_id, issue.related.kind, issue.related.target_id)}`}>{t('printStateRecovery.episode.related')}</a>}
  </div>;
}

function historyOutcome(row: PrintStateAudit, t: (key: string) => string): string | null {
  if (row.action !== 'clear_terminal_runtime_context') return null;
  const outcome = row.outcome;
  if (outcome && typeof outcome === 'object') {
    const reason = outcome.reason ? ` (${t(`printStateRecovery.outcomeReasons.${outcome.reason}`)})` : '';
    return `${t(`printStateRecovery.historyOutcome.${outcome.outcome}`)}${reason}`;
  }
  return t(row.process_ended ? 'printStateRecovery.historyOutcome.processEnded' : 'printStateRecovery.historyOutcome.unknown');
}

export function PrintStateIssuesPanel() {
  const { t } = useTranslation();
  const { hasAllPermissions } = useAuth();
  const allowed = hasAllPermissions('system:read', 'printers:read', 'queue:read_all', 'archives:read_all');
  const queryClient = useQueryClient();
  const initialPrinter = Number(new URLSearchParams(window.location.search).get('printer_id')) || undefined;
  const [printer, setPrinter] = useState<number | undefined>(initialPrinter);
  const [cursor, setCursor] = useState<string | undefined>();
  const [selection, setSelection] = useState<{ issue: PrintStateIssue; action: PrintStateAction } | null>(null);
  const [history, setHistory] = useState<{ printer: number; rows: PrintStateAudit[]; next: string | null } | null>(null);
  const [historyError, setHistoryError] = useState(false);
  const [historyBusy, setHistoryBusy] = useState(false);
  const query = useQuery({ queryKey: ['print-state-issues', printer, cursor],
    queryFn: () => api.getPrintStateIssues({ printer_id: printer, cursor }), enabled: allowed,
    refetchInterval: 60_000, refetchIntervalInBackground: false,
  });
  if (!allowed) return null;
  const reload = () => {
    void queryClient.invalidateQueries({ queryKey: ['print-state-issues'] });
    void queryClient.invalidateQueries({ queryKey: ['queue'] });
    void queryClient.invalidateQueries({ queryKey: ['archives'] });
    setHistory(null);
  };
  const showHistory = async (printerId: number, before?: string) => {
    if (historyBusy) return;
    setHistoryBusy(true); setHistoryError(false);
    try {
      const result = await api.getPrintStateHistory(printerId, before);
      setHistory(current => ({ printer: printerId, next: result.next_cursor,
        rows: before && current?.printer === printerId ? [...current.rows, ...result.actions] : result.actions }));
    } catch { setHistoryError(true); }
    finally { setHistoryBusy(false); }
  };
  return <section id="print-state" aria-label={t('printStateRecovery.title')}>
    <Card className="p-4 space-y-4">
      <div className="flex flex-wrap justify-between items-center gap-3">
        <h2 className="text-lg font-semibold">{t('printStateRecovery.title')}</h2>
        <Button variant="secondary" size="sm" onClick={() => void query.refetch()} disabled={query.isFetching}>{t('printStateRecovery.refresh')}</Button>
      </div>
      <p className="text-sm text-bambu-gray">{t('printStateRecovery.description')}</p>
      <label className="flex flex-wrap items-center gap-2 text-sm">{t('printStateRecovery.printerFilter')}
        <input type="number" min={1} value={printer ?? ''} placeholder={t('printStateRecovery.allPrinters')}
          className="bg-bambu-dark border border-bambu-dark-tertiary rounded px-2 py-1 w-28"
          onChange={e => { setPrinter(Number(e.target.value) || undefined); setCursor(undefined); setHistory(null); }} />
      </label>
      {query.isPending && <p role="status">{t('common.loading')}</p>}
      {query.isError && <p role="alert">{t('printStateRecovery.failed')}</p>}
      {query.data && <>
        <p className="text-xs text-bambu-gray">{t('printStateRecovery.checkedAt')}: {formatDateTime(query.data.checked_at)}</p>
        <p className="text-xs text-bambu-gray">{t('printStateRecovery.count', { count: query.data.issues.length })}</p>
        {query.data.issues.length === 0 && <p>{t(query.data.truncated ? 'printStateRecovery.partial' : 'printStateRecovery.empty')}</p>}
        <div className="space-y-3">{query.data.issues.map(issue => <article key={`${issue.printer_id}:${issue.kind}:${issue.target_id}`}
          id={rowAnchor(issue.printer_id, issue.kind, issue.target_id)}
          className="rounded border border-bambu-dark-tertiary p-3 space-y-2">
          <h3 className="font-medium break-words">{issue.printer_name} · {t(`printStateRecovery.issues.${issue.code}`)}</h3>
          {issue.kind === 'runtime' ? <RuntimeDetails issue={issue} />
            : issue.kind === 'episode' ? <EpisodeDetails issue={issue} />
              : <>
                <p className="text-sm">{t('printStateRecovery.target', { item: issue.item_id ?? '—', archive: issue.archive_id ?? '—' })}</p>
                <p className="text-xs text-bambu-gray">{t(`printStateRecovery.live.${issue.live_mode}`)}</p>
              </>}
          {issue.blocked_reasons.map(reason => <p key={reason} className="text-xs text-bambu-gray">{t(`printStateRecovery.reasons.${reason}`)}</p>)}
          <div className="flex flex-wrap gap-2">{issue.actions.map(action => <Button key={action} variant={action === 'delete_stale_item' ? 'danger' : 'secondary'}
            size="sm" onClick={() => setSelection({ issue, action })}>{t(`printStateRecovery.actions.${action}`)}</Button>)}
            <Button variant="ghost" size="sm" onClick={() => void showHistory(issue.printer_id)} disabled={historyBusy}>{t('printStateRecovery.history')}</Button>
          </div>
        </article>)}</div>
        <div className="flex gap-2">
          {cursor && <Button variant="secondary" onClick={() => setCursor(undefined)}>{t('printStateRecovery.firstPage')}</Button>}
          {query.data.next_cursor && <Button variant="secondary" onClick={() => setCursor(query.data?.next_cursor ?? undefined)}>{t('printStateRecovery.nextPage')}</Button>}
        </div>
      </>}
      {printer && <Button variant="ghost" onClick={() => void showHistory(printer)} disabled={historyBusy}>{t('printStateRecovery.history')}</Button>}
      {historyError && <p role="alert">{t('printStateRecovery.failed')}</p>}
      {history && <div className="border-t border-bambu-dark-tertiary pt-3 space-y-2">
        <h3>{t('printStateRecovery.history')} · #{history.printer}</h3>
        {history.rows.length === 0 && <p>{t('printStateRecovery.historyEmpty')}</p>}
        {history.rows.map(row => <p key={row.id} className="text-sm break-words">{row.created_at ? formatDateTime(row.created_at) : ''}
          {' · '}{row.actor_label}{' · '}{t(`printStateRecovery.actions.${row.action}`)}{' · '}
          {t('printStateRecovery.target', { item: row.item_id ?? '—', archive: row.archive_id ?? '—' })}
          {historyOutcome(row, t) ? ` · ${historyOutcome(row, t)}` : ''}
          {row.note ? ` · ${row.note}` : ''}</p>)}
        {history.next && <Button variant="secondary" onClick={() => void showHistory(history.printer, history.next ?? undefined)}
          disabled={historyBusy}>{t('printStateRecovery.nextPage')}</Button>}
      </div>}
    </Card>
    {selection && <PrintStateRecoveryDialog issue={selection.issue} action={selection.action} onClose={() => setSelection(null)} onApplied={reload} />}
  </section>;
}
