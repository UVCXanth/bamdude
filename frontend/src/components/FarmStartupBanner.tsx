import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, type FarmStartupState } from '../api/client';
import { Button } from './Button';
import { ConfirmModal } from './ConfirmModal';

const farmStartupKey = ['farm-startup'] as const;

/** One shell reader for the farm, including Queue and System. No per-printer polling. */
export function FarmStartupBanner() {
  const { t } = useTranslation();
  const cache = useQueryClient();
  const [confirmation, setConfirmation] = useState<FarmStartupState | null>(null);
  const [failed, setFailed] = useState(false);
  const query = useQuery({
    queryKey: farmStartupKey, queryFn: api.getFarmStartup, refetchInterval: 30_000, retry: 1,
  });
  const resume = useMutation({
    mutationFn: (state: FarmStartupState) => api.resumeFarmStartup(state.boot_id!, state.hold_id!),
    onSuccess: async () => {
      setConfirmation(null);
      setFailed(false);
      // Never optimistically hide a hold from a stale response.
      await cache.invalidateQueries({ queryKey: farmStartupKey });
    },
    onError: async () => {
      setConfirmation(null);
      setFailed(true);
      await cache.invalidateQueries({ queryKey: farmStartupKey });
    },
  });
  const state = query.data;
  if (!query.isError && state?.state === 'running' && !failed) return null;
  const key = query.isError ? 'unavailable' : state?.state ?? 'starting';
  return (
    <section role="status" aria-live="polite" className="border-b border-amber-500/40 bg-amber-500/10 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1 basis-64 text-sm">
          <p className="font-semibold text-amber-700 dark:text-amber-300">{t(`farmStartup.${key}`)}</p>
          {state?.state === 'held' && <p className="mt-1 text-bambu-gray">{t('farmStartup.detail')}</p>}
          {failed && <p role="alert" className="mt-1 text-red-500">{t('farmStartup.failed')}</p>}
        </div>
        {!query.isError && state?.can_resume && (
          <Button variant="secondary" onClick={() => setConfirmation(state)}>{t('farmStartup.resume')}</Button>
        )}
      </div>
      {confirmation && (
        <ConfirmModal title={t('farmStartup.resume')} message={t('farmStartup.confirm')}
          confirmText={t('farmStartup.resume')} variant="warning" isLoading={resume.isPending}
          onCancel={() => setConfirmation(null)} onConfirm={() => resume.mutate(confirmation)} />
      )}
    </section>
  );
}
