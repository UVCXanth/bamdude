import { useTranslation } from 'react-i18next';
import type { OrderListItem } from '../../../api/client';
import { ResponsibleName } from '../ResponsibleName';

/** The responsible person — initials (24 px) and name — or a muted «unassigned» (WS-13 E7 B01). */
export function OrderResponsible({
  order,
  className = '',
}: {
  order: Pick<OrderListItem, 'responsible_name'>;
  className?: string;
}) {
  const { t } = useTranslation();
  if (!order.responsible_name) return <span className={`text-bambu-gray ${className}`}>{t('orders.row.unassigned')}</span>;
  return <ResponsibleName name={order.responsible_name} className={className} />;
}
