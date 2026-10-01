import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import type { EstimateReason } from '../../../api/client';

/**
 * The amber triangle beside a date the estimate cannot fully stand behind
 * (WS-13 E7 B03) — the order page's «Ready ≈» tile draws the same one. Its name is
 * the reasons themselves, so a screen reader hears why, not only that; the
 * wrapper's `title` is the mouse's tooltip (an SVG attribute shows none).
 */
export function EstimateWarning({ reasons }: { reasons: EstimateReason[] }) {
  const { t } = useTranslation();
  if (reasons.length === 0) return null;
  const list = reasons
    .map((r) => `${t(`projects.estimateReasons.${r.code}`)}${r.count != null ? `: ${r.count}` : ''}`)
    .join(', ');
  const name = t('orders.row.incompleteReasons', { reasons: list });
  return (
    <span title={name} className="ml-1 inline-flex flex-shrink-0">
      <AlertTriangle role="img" aria-label={name} className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
    </span>
  );
}
