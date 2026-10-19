import { useTranslation } from 'react-i18next';
import { PauseCircle } from 'lucide-react';
import { swapHoldText } from '../utils/swapHold';

/** The print's held table swap, beside its SWAP badge: the sentence is the badge's title. */
export function SwapHoldBadge({ extraData, className = '' }: { extraData: unknown; className?: string }) {
  const { t } = useTranslation();
  const text = swapHoldText(t, extraData);
  if (!text) return null;
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-[10px] px-1 py-0.5 bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400 rounded ${className}`}
      title={text}
      aria-label={text}
    >
      <PauseCircle className="w-3 h-3" />
      {t('archives.swapHold.badge')}
    </span>
  );
}
