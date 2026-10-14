import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, ShieldCheck } from 'lucide-react';
import {
  api,
  ApiError,
  type SwapDeclarationResult,
  type SwapRefreshCandidate,
  type SwapRefreshResult,
  type SwapSourceKind,
} from '../api/client';
import { Button } from './Button';
import { Modal } from './Modal';
import { formatFileSize } from '../utils/file';
import { formatDateTime } from '../utils/date';
import { newOperationId } from '../utils/swapCompatibility';
import { invalidateQueueViews } from '../utils/queryInvalidation';

interface SwapDeclarationModalProps {
  kind: SwapSourceKind;
  id: number;
  /** The source's name as the page shows it, until the file has been read. */
  name?: string;
  /** The read and update right of this very source; without it the dialog only shows. */
  canDeclare: boolean;
  onClose: () => void;
}

function jobKey(job: { kind: string; id: number }): string {
  return `${job.kind}:${job.id}`;
}

/**
 * One operation id per request: the same request sent again -- its answer lost -- is the same operation, which the
 * server answers with its first result instead of a conflict; any other request is a new one.
 */
function useOperationId() {
  const current = useRef<{ key: string; id: string } | null>(null);
  return {
    for(key: string): string {
      if (current.current?.key !== key) current.current = { key, id: newOperationId() };
      return current.current.id;
    },
    reset() {
      current.current = null;
    },
  };
}

/**
 * The operator's swap declaration of one source (swap-source-declaration spec r3 §4-§7): read the
 * bytes a reprint would print, say whether they carry their own plate-change sequence, save it for
 * exactly those bytes -- then, as a separate step, apply it to queued jobs the operator selects.
 *
 * Nothing is chosen for the operator: neither answer, nor any job. A source that changed since it
 * was read is a conflict to read again. A refused refresh keeps the saved declaration, and trying
 * again sends the refresh alone. A refresh is no Retry: a failed job stays failed.
 */
export function SwapDeclarationModal({ kind, id, name, canDeclare, onClose }: SwapDeclarationModalProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [choice, setChoice] = useState<boolean | null>(null);
  const [saved, setSaved] = useState<SwapDeclarationResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [refreshed, setRefreshed] = useState<SwapRefreshResult | null>(null);
  const declareOperation = useOperationId();
  const refreshOperation = useOperationId();

  const inspection = useQuery({
    queryKey: ['swap-declaration-inspect', kind, id],
    queryFn: () => api.inspectSwapDeclaration(kind, id),
    retry: false,
    refetchOnWindowFocus: false,
    gcTime: 0,
  });
  const read = inspection.data;

  const declare = useMutation({
    mutationFn: (value: boolean) =>
      api.declareSwapSource(kind, id, {
        value,
        expected_sha256: read!.sha256,
        expected_revision: read!.revision,
        operation_id: declareOperation.for(`${value}:${read!.revision}`),
      }),
    onSuccess: (result) => {
      setSaved(result);
      // The print dialog reads the source again; a failed invalidation never undoes a committed save.
      queryClient.invalidateQueries({ queryKey: kind === 'archive' ? ['archive', id] : ['library-file', id] });
      queryClient.invalidateQueries({ queryKey: kind === 'archive' ? ['archives'] : ['library-files'] });
    },
  });

  // An operator's declaration that stands -- just saved, or found by the reading -- can be applied to jobs.
  const declarationId = saved?.declaration_id ?? (read?.origin === 'operator' ? read.declaration_id : null);
  const history = useQuery({
    queryKey: ['swap-declaration-history', kind, id, declarationId],
    queryFn: () => api.getSwapDeclarationHistory(kind, id),
    enabled: saved !== null,
    retry: false,
  });

  const jobs = useQuery({
    queryKey: ['swap-declaration-jobs', kind, id, declarationId],
    queryFn: () => api.getSwapDeclarationJobs(kind, id),
    enabled: declarationId !== null && canDeclare,
    retry: false,
  });

  const refresh = useMutation({
    mutationFn: (picked: SwapRefreshCandidate[]) =>
      api.refreshSwapDeclarationJobs(kind, id, {
        declaration_id: jobs.data!.declaration_id,
        source_revision: jobs.data!.source_revision,
        operation_id: refreshOperation.for(
          [jobs.data!.declaration_id, jobs.data!.source_revision, ...picked.map((job) => `${jobKey(job)}@${job.revision}`)].join('|'),
        ),
        jobs: picked.map((job) => ({ kind: job.kind, id: job.id, revision: job.revision })),
      }),
    onSuccess: (result) => {
      setRefreshed(result);
      setSelected(new Set());
      refreshOperation.reset();
      invalidateQueueViews(queryClient);
      queryClient.invalidateQueries({ queryKey: ['queue-copy-source'] });
      queryClient.invalidateQueries({ queryKey: ['swap-declaration-jobs', kind, id] });
    },
    onError: () => {
      // What was listed may be stale now: list again, keep nothing selected.
      setSelected(new Set());
      queryClient.invalidateQueries({ queryKey: ['swap-declaration-jobs', kind, id] });
    },
  });

  const declareError = declare.error instanceof ApiError ? declare.error : null;
  const sourceChanged = declareError?.code === 'swap_source_changed';
  const readAgain = () => {
    setChoice(null);
    declare.reset();
    declareOperation.reset();
    inspection.refetch();
  };

  const listed = useMemo(() => jobs.data?.jobs ?? [], [jobs.data]);
  const eligible = listed.filter((job) => job.eligible);
  const picked = eligible.filter((job) => selected.has(jobKey(job)));
  const busy = declare.isPending || refresh.isPending;

  const describe = (value: boolean | null) =>
    value === true
      ? t('swapDeclaration.current.carries')
      : value === false
        ? t('swapDeclaration.current.doesNot')
        : t('swapDeclaration.current.unknown');

  const jobLabel = (job: SwapRefreshCandidate) => {
    const status = t(`swapDeclaration.jobs.status.${job.status}`, { defaultValue: job.status });
    return job.kind === 'queue'
      ? t('swapDeclaration.jobs.queueJob', { id: job.id, status })
      : t('swapDeclaration.jobs.autoJob', { id: job.id, status });
  };

  return (
    <Modal
      onClose={onClose}
      closeDisabled={busy}
      title={t('swapDeclaration.title')}
      icon={<ShieldCheck className="w-5 h-5 text-bambu-green" />}
      size="lg"
      footer={
        <div className="flex justify-end">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('common.close')}
          </Button>
        </div>
      }
    >
      <div className="space-y-4 p-4 text-sm">
        {inspection.isLoading && (
          <p className="flex items-center gap-2 text-bambu-gray">
            <Loader2 className="w-4 h-4 animate-spin" />
            {t('swapDeclaration.reading', { name: name ?? '' })}
          </p>
        )}

        {inspection.isError && (
          <div className="space-y-2" role="alert">
            <p className="text-red-400">
              {inspection.error instanceof Error ? inspection.error.message : t('swapDeclaration.readFailed')}
            </p>
            <Button variant="secondary" size="sm" onClick={() => inspection.refetch()}>
              {t('swapDeclaration.tryAgain')}
            </Button>
          </div>
        )}

        {read && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-bambu-gray">{t('swapDeclaration.file')}</dt>
            <dd className="text-white break-all">{read.display_filename}</dd>
            <dt className="text-bambu-gray">{t('swapDeclaration.size')}</dt>
            <dd className="text-white">{formatFileSize(read.size_bytes)}</dd>
            <dt className="text-bambu-gray">{t('swapDeclaration.hash')}</dt>
            <dd className="text-white font-mono" title={read.sha256}>
              {read.sha256.slice(0, 12)}…
            </dd>
            <dt className="text-bambu-gray">{t('swapDeclaration.currentLabel')}</dt>
            <dd className="text-white">{describe(saved ? saved.value : read.current)}</dd>
          </dl>
        )}

        {read && !canDeclare && <p className="text-bambu-gray">{t('swapDeclaration.readOnly')}</p>}

        {read && canDeclare && !saved && (
          <fieldset className="space-y-2" disabled={declare.isPending}>
            <legend className="text-white font-medium mb-1">{t('swapDeclaration.question')}</legend>
            {[true, false].map((value) => (
              <label key={String(value)} className="flex items-start gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="swap-declaration"
                  className="mt-1"
                  checked={choice === value}
                  onChange={() => setChoice(value)}
                />
                <span className="text-white">
                  {value ? t('swapDeclaration.optionCarries') : t('swapDeclaration.optionDoesNot')}
                </span>
              </label>
            ))}
            <p className="text-bambu-gray">{t('swapDeclaration.explain')}</p>
            {sourceChanged && (
              <div className="space-y-2" role="alert">
                <p className="text-amber-400">{t('swapDeclaration.changed')}</p>
                <Button variant="secondary" size="sm" onClick={readAgain}>
                  {t('swapDeclaration.readAgain')}
                </Button>
              </div>
            )}
            {declare.error && !sourceChanged && (
              <p className="text-red-400" role="alert">
                {declareError ? declareError.message : t('swapDeclaration.saveFailed')}
              </p>
            )}
            <Button
              onClick={() => choice !== null && declare.mutate(choice)}
              disabled={choice === null || declare.isPending || sourceChanged}
            >
              {declare.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {t('swapDeclaration.save')}
            </Button>
          </fieldset>
        )}

        {saved && (
          <div className="space-y-1">
            <p className="text-bambu-green">{t('swapDeclaration.saved')}</p>
            {history.data?.[0] && (
              <p className="text-bambu-gray">
                {t('swapDeclaration.savedBy', {
                  actor: history.data[0].actor_label,
                  when: formatDateTime(history.data[0].created_at),
                })}
              </p>
            )}
          </div>
        )}

        {declarationId !== null && canDeclare && (
          <section className="space-y-2 border-t border-bambu-dark-tertiary pt-3">
            <h3 className="text-white font-medium">{t('swapDeclaration.jobs.title')}</h3>
            <p className="text-bambu-gray">{t('swapDeclaration.jobs.intro')}</p>
            {jobs.isLoading && <Loader2 className="w-4 h-4 animate-spin text-bambu-gray" />}
            {jobs.data && listed.length === 0 && <p className="text-bambu-gray">{t('swapDeclaration.jobs.none')}</p>}
            {jobs.data && listed.length > 0 && (
              <>
                <p className="text-bambu-gray">
                  {t('swapDeclaration.jobs.counts', {
                    eligible: jobs.data.counts.eligible,
                    refused: jobs.data.counts.refused,
                  })}
                </p>
                <ul className="space-y-1">
                  {listed.map((job) =>
                    job.eligible ? (
                      <li key={jobKey(job)}>
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={selected.has(jobKey(job))}
                            disabled={refresh.isPending}
                            onChange={(event) =>
                              setSelected((current) => {
                                const next = new Set(current);
                                if (event.target.checked) next.add(jobKey(job));
                                else next.delete(jobKey(job));
                                return next;
                              })
                            }
                          />
                          <span className="text-white">{jobLabel(job)}</span>
                        </label>
                      </li>
                    ) : (
                      <li key={jobKey(job)} className="text-bambu-gray">
                        {jobLabel(job)} — {t(`swapDeclaration.jobs.reason.${job.reason ?? 'job_gone'}`)}
                      </li>
                    ),
                  )}
                </ul>
                {refresh.error && (
                  <div className="space-y-1" role="alert">
                    <p className="text-amber-400">{t('swapDeclaration.jobs.failed')}</p>
                    <p className="text-bambu-gray">{refresh.error.message}</p>
                  </div>
                )}
                <Button onClick={() => refresh.mutate(picked)} disabled={picked.length === 0 || refresh.isPending}>
                  {refresh.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                  {t('swapDeclaration.jobs.apply', { count: picked.length })}
                </Button>
              </>
            )}
            {refreshed && (
              <p className="text-bambu-green">{t('swapDeclaration.jobs.done', { count: refreshed.refreshed.length })}</p>
            )}
          </section>
        )}
      </div>
    </Modal>
  );
}
