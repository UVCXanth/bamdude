import { useTranslation } from 'react-i18next';
import { Clock, Play } from 'lucide-react';
import type { OrderListItem } from '../../../api/client';

/** «▶ p · ⏱ q» — prints running and jobs waiting for an order (WS-13 E7 B01); a dash when both are zero. */
export function LiveCounts({ order }: { order: Pick<OrderListItem, 'id' | 'prints_in_progress' | 'prints_queued'> }) {
  const { t } = useTranslation();
  const testId = `order-${order.id}-live`;
  if (order.prints_in_progress <= 0 && order.prints_queued <= 0) {
    return (
      <span data-testid={testId} className="text-bambu-gray">
        —
      </span>
    );
  }
  return (
    <span
      data-testid={testId}
      role="img"
      aria-label={t('orders.row.live', { printing: order.prints_in_progress, queued: order.prints_queued })}
      className="inline-flex items-center gap-1 tabular-nums whitespace-nowrap"
    >
      <Play className="w-3 h-3" aria-hidden="true" />
      {order.prints_in_progress}
      <span aria-hidden="true" className="text-bambu-gray">·</span>
      <Clock className="w-3 h-3" aria-hidden="true" />
      {order.prints_queued}
    </span>
  );
}
