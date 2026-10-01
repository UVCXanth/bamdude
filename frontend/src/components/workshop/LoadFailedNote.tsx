import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * A read that failed with nothing of its own to show, and its retry (WS-13 E7 C05).
 * Never the empty state: «nothing here» and «could not ask» are different answers.
 * `alert` for the main content (a list, a board), `status` for a side figure
 * (tiles, a forecast column) that should not interrupt a screen reader.
 * A retry that returns a promise (a query's `refetch`) marks the note busy until it
 * answers, and is not sent twice meanwhile.
 */
export function LoadFailedNote({
  message,
  onRetry,
  role = 'alert',
  className = '',
}: {
  message: string;
  onRetry: () => unknown;
  role?: 'alert' | 'status';
  className?: string;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const retry = () => {
    if (busy) return;
    const answer = onRetry();
    if (answer && typeof (answer as PromiseLike<unknown>).then === 'function') {
      setBusy(true);
      const done = () => {
        if (mounted.current) setBusy(false);
      };
      (answer as PromiseLike<unknown>).then(done, done);
    }
  };
  return (
    <div
      role={role}
      aria-busy={busy ? 'true' : undefined}
      className={`flex flex-wrap items-center gap-2 text-sm text-amber-700 dark:text-amber-400 ${className}`}
    >
      <span>{message}</span>
      <button
        type="button"
        onClick={retry}
        aria-disabled={busy ? 'true' : undefined}
        className="text-bambu-green hover:underline aria-disabled:cursor-default aria-disabled:opacity-70"
      >
        {busy ? t('common.loading') : t('common.retry')}
      </button>
    </div>
  );
}
