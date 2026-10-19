import { useTranslation } from 'react-i18next';
import type { Archive } from '../api/client';
import { formatDateTime } from '../utils/date';

export function RecoveryEndTime({ archive }: { archive: Archive }) {
  const { t } = useTranslation();
  if (archive.end_time_source !== 'slicer_estimate' || !archive.completed_at) return null;
  return <span className="block text-xs whitespace-normal text-amber-700 dark:text-amber-300">
    {t('printStateRecovery.estimatedLabel')}: {formatDateTime(archive.completed_at)}
  </span>;
}
