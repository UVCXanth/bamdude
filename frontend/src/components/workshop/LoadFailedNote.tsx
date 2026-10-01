import { useTranslation } from 'react-i18next';

/**
 * A read that failed with nothing of its own to show, and its retry (WS-13 E7 C05).
 * Never the empty state: «nothing here» and «could not ask» are different answers.
 * `alert` for the main content (a list, a board), `status` for a side figure
 * (tiles, a forecast column) that should not interrupt a screen reader.
 */
export function LoadFailedNote({
  message,
  onRetry,
  role = 'alert',
  className = '',
}: {
  message: string;
  onRetry: () => void;
  role?: 'alert' | 'status';
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <div role={role} className={`flex flex-wrap items-center gap-2 text-sm text-amber-700 dark:text-amber-400 ${className}`}>
      <span>{message}</span>
      <button type="button" onClick={onRetry} className="text-bambu-green hover:underline">
        {t('common.retry')}
      </button>
    </div>
  );
}
