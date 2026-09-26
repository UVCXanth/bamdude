import { useTranslation } from 'react-i18next';
import type { OrderStageShown, ProjectStatus } from '../../api/client';
import { StatusBadge } from './StatusBadge';

/** Colours already used on these pages (OrderTimeline, StatusBadge) — no new ones. */
const COLOURS: Record<OrderStageShown, string> = {
  prep: 'bg-yellow-100 dark:bg-yellow-500/20 text-yellow-700 dark:text-yellow-400',
  printing: 'bg-bambu-green/20 text-bambu-green',
  qc: 'bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-400',
  done: 'bg-status-ok/20 text-status-ok',
};

/**
 * An order's stage (spec workshop-order-stage, rule 29). A cancelled order has
 * no stage — it shows its status instead, so the column is never blank.
 */
export function StageBadge({ stage, status }: { stage: OrderStageShown | null; status: ProjectStatus }) {
  const { t } = useTranslation();
  if (stage == null) return <StatusBadge status={status} />;
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${COLOURS[stage]}`}>{t(`orders.stage.${stage}`)}</span>
  );
}
