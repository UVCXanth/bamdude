import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError, type PrintStateAction, type PrintStateIssue, type PrintStatePreview } from '../api/client';
import { Button } from './Button';
import { Modal } from './Modal';
import { formatDateTime } from '../utils/date';

export function PrintStateRecoveryDialog({ issue, action, onClose, onApplied }: {
  issue: PrintStateIssue; action: PrintStateAction; onClose: () => void; onApplied: () => void;
}) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<PrintStatePreview | null>(null);
  const [completed, setCompleted] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const estimate = action === 'fill_estimated_end_and_align';
  const shown = (key: string, value: unknown): string => {
    if (value === null || value === undefined) return '—';
    if (key === 'waiting_reason' && value === true) return t('printStateRecovery.recordedReason');
    if (typeof value === 'boolean') return t(value ? 'common.yes' : 'common.no');
    if (key === 'completed_at' && typeof value === 'string') return formatDateTime(value);
    if (key === 'status') return t(`printStateRecovery.states.${String(value)}`);
    if (key === 'time_source') return t('printStateRecovery.slicerEstimate');
    return String(value);
  };

  const prepare = async () => {
    setBusy(true); setError(null); setPreview(null); setConfirmed(false);
    try {
      const result = await api.previewPrintState(issue.printer_id, {
        kind: issue.kind as 'item' | 'header', target_id: issue.target_id, action,
        confirmed_completed: completed, note,
      });
      setPreview(result);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 409 ? t('printStateRecovery.changed') : t('printStateRecovery.failed'));
    } finally { setBusy(false); }
  };
  const apply = async () => {
    if (!preview || !confirmed || busy) return;
    setBusy(true); setError(null);
    try {
      await api.applyPrintState(issue.printer_id, preview.preview_token);
      onApplied(); onClose();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setPreview(null); setConfirmed(false); setError(t('printStateRecovery.changed'));
      } else {
        // Retain the same token after a lost response: the server's audit makes
        // retry idempotent. A conflict instead needs a fresh explicit preview.
        setError(t('printStateRecovery.failed'));
      }
    } finally { setBusy(false); }
  };

  return <Modal title={t(`printStateRecovery.actions.${action}`)} onClose={onClose} closeDisabled={busy} size="lg">
    <div className="p-4 space-y-4 text-sm">
      <p className="break-words">{issue.printer_name} · {t('printStateRecovery.target', {
        item: issue.item_id ?? '—', archive: issue.archive_id ?? '—',
      })}</p>
      <p>{t('printStateRecovery.preserved')}</p>
      {estimate && <p className="text-amber-600 dark:text-amber-300">{t('printStateRecovery.estimate')}</p>}
      {!preview && <>
        {estimate && <label className="flex gap-2 items-start">
          <input type="checkbox" checked={completed} onChange={e => setCompleted(e.target.checked)} />
          <span>{t('printStateRecovery.completedConfirmation')}</span>
        </label>}
        <label className="block">{t('printStateRecovery.note')}
          <textarea className="mt-1 block w-full bg-bambu-dark border border-bambu-dark-tertiary rounded p-2"
            maxLength={500} value={note} onChange={e => setNote(e.target.value)} />
        </label>
        <Button onClick={() => void prepare()} disabled={busy || (estimate && !completed)}>{t('printStateRecovery.preview')}</Button>
      </>}
      {preview && <>
        {preview.estimate && <p className="text-amber-700 dark:text-amber-300">{t('printStateRecovery.estimatedLabel')}: {' '}
          {formatDateTime(preview.estimate.started_at)} + {preview.estimate.duration_seconds}s → {formatDateTime(preview.estimate.completed_at)}
        </p>}
        <div className="overflow-x-auto">
          <table className="w-full text-left"><thead><tr><th>{t('printStateRecovery.field')}</th>
            <th>{t('printStateRecovery.before')}</th><th>{t('printStateRecovery.after')}</th></tr></thead>
            <tbody>{(['queue', 'item', 'archive'] as const).flatMap(kind =>
              Object.entries(preview.after[kind]).filter(([key]) => key !== 'extra_data').map(([key, value]) =>
                <tr key={`${kind}.${key}`}><td className="py-2 pr-2">{t(`printStateRecovery.fields.${kind}`)}: {t(`printStateRecovery.fields.${key}`)}</td>
                  <td className="pr-2 break-words">{shown(key, preview.before[kind][key])}</td><td className="break-words">{shown(key, value)}</td></tr>))}
              {preview.after.delete_item && <tr><td>{t('printStateRecovery.fields.item')}</td>
                <td>#{issue.item_id}</td><td>{t('printStateRecovery.deleted')}</td></tr>}
            </tbody></table>
        </div>
        {Object.keys(preview.after.queue).length > 0 && <p>{t('printStateRecovery.paused')}</p>}
        <label className="flex gap-2 items-start"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />
          <span>{t('printStateRecovery.confirm')}</span></label>
        <Button variant={action === 'delete_stale_item' ? 'danger' : 'primary'} onClick={() => void apply()}
          disabled={busy || !confirmed}>{t('printStateRecovery.apply')}</Button>
      </>}
      {error && <p role="alert" className="text-red-600 dark:text-red-300">{error}</p>}
      {busy && <p role="status">{t('common.loading')}</p>}
      <Button variant="secondary" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
    </div>
  </Modal>;
}
