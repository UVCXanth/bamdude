import { useTranslation } from 'react-i18next';
import type { ListSortOption } from '../components/ListSortControl';

/** Every server key of the orders list, for the cards' sort control (the table
 *  sorts from its headers) — one list for the orders page and the customer page. */
export function useOrderSortOptions(): ListSortOption[] {
  const { t } = useTranslation();
  return [
    { key: 'updated', label: t('list.sort.updated'), descFirst: true },
    { key: 'created', label: t('list.sort.created'), descFirst: true },
    { key: 'name', label: t('orders.table.name') },
    { key: 'due', label: t('orders.table.due') },
    { key: 'priority', label: t('orders.modal.priority'), descFirst: true },
    { key: 'customer', label: t('orders.table.customer') },
    { key: 'progress', label: t('orders.table.progress'), descFirst: true },
    { key: 'remaining', label: t('orders.table.remaining'), descFirst: true },
    { key: 'printing', label: t('orders.table.printing'), descFirst: true },
    { key: 'queued', label: t('orders.table.queued'), descFirst: true },
    { key: 'ready', label: t('orders.table.readyAt') },
    { key: 'hours', label: t('orders.table.machineHours'), descFirst: true },
  ];
}
