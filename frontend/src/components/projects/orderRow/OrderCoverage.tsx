import { useTranslation } from 'react-i18next';
import type { OrderListItem } from '../../../api/client';
import { ProgressBar } from '../ProgressBar';

/**
 * Coverage of one order in a list (WS-13 E7 B02): covered / ordered, the server's
 * percentage, the bar, and — except in a workspace row — where it came from,
 * naming only the sources that are not zero. The card and the board say
 * «Covered»; the table's column header says it already.
 */
export function OrderCoverage({
  order,
  variant,
}: {
  order: Pick<OrderListItem, 'id' | 'ordered' | 'covered_units' | 'progress' | 'printed' | 'from_stock_units'>;
  variant: 'table' | 'card' | 'row';
}) {
  const { t } = useTranslation();
  const testId = `order-${order.id}-coverage`;
  if (order.ordered <= 0) {
    return (
      <span data-testid={testId} className="text-bambu-gray">
        —
      </span>
    );
  }
  const sources = [
    order.printed > 0 ? t('orders.row.printed', { count: order.printed }) : null,
    order.from_stock_units > 0 ? t('orders.row.fromStock', { count: order.from_stock_units }) : null,
  ].filter((s): s is string => s != null);
  return (
    <div data-testid={testId} className="min-w-0 space-y-1">
      <ProgressBar
        value={order.covered_units}
        max={order.ordered}
        progress={order.progress}
        label={variant === 'card' ? t('orders.card.covered') : undefined}
        caption="both"
        testId={`order-${order.id}-progress`}
      />
      {variant !== 'row' && sources.length > 0 && (
        <p className="text-xs text-bambu-gray">{sources.join(' · ')}</p>
      )}
    </div>
  );
}
