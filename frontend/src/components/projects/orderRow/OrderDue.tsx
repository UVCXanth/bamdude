import { useTranslation } from 'react-i18next';
import type { OrderListItem } from '../../../api/client';
import { isOverdue } from '../../../utils/orderDates';
import { dueLabel, useDateSettings } from './useDateSettings';

/**
 * An order's deadline in a list (WS-13 E7 B05): the calendar day in the user's
 * format, red with «overdue» past it (`isOverdue` — the one rule the orders
 * summary counts by), a dash without one. `cell` puts «overdue» on its own line
 * (the table); `inline` and `meta` keep it on the date's line; `plain` is the red
 * date alone (a workspace row, «code · date», as the mockup).
 */
export function OrderDue({
  order,
  variant,
}: {
  order: Pick<OrderListItem, 'id' | 'status' | 'due_date'>;
  variant: 'cell' | 'meta' | 'inline' | 'plain';
}) {
  const { t } = useTranslation();
  const { dateFormat } = useDateSettings();
  const testId = `order-${order.id}-due`;
  if (!order.due_date) {
    return (
      <span data-testid={testId} className="text-bambu-gray">
        —
      </span>
    );
  }
  const overdue = isOverdue(order);
  return (
    <span data-testid={testId} className={variant === 'cell' ? 'block' : undefined}>
      <span className={`tabular-nums ${overdue ? 'text-red-500' : ''}`}>{dueLabel(order.due_date, dateFormat)}</span>
      {overdue && variant !== 'plain' &&
        (variant === 'cell' ? (
          <small className="block text-xs text-red-500">{t('orders.row.overdue')}</small>
        ) : (
          <span className="text-red-500"> · {t('orders.row.overdue')}</span>
        ))}
    </span>
  );
}
