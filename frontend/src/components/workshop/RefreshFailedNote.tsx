import { useTranslation } from 'react-i18next';

/**
 * A refresh that failed over an answer the panel still shows (WS-13 E3 R02,
 * E3-V03): the last answer stays and says it is not fresh — an empty answer
 * too, since «nothing» read before the failure is not a confirmed current state.
 * A read that never answered is not this: that is the panel's own error + retry.
 */
export function RefreshFailedNote({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <p className="mb-2 flex flex-wrap items-center gap-2 text-xs text-amber-400">
      {t('orders.detail.refreshFailed')}
      <button type="button" onClick={onRetry} className="text-bambu-green hover:underline">
        {t('common.retry')}
      </button>
    </p>
  );
}
