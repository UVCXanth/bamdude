import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import type { Customer } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { formatMoney } from '../../utils/currency';
import { SortableHeader } from '../SortableHeader';
import { CustomerActions } from './CustomerActions';

interface CustomersTableProps {
  customers: Customer[];
  onEdit: (customer: Customer) => void;
  onDelete: (customer: Customer) => void;
  /** The list's `sort_by`; the headers ask the SERVER to sort. */
  sort: string;
  onSortChange: (sortBy: string) => void;
  /** The page bar, drawn inside the same card under the rows. */
  footer?: ReactNode;
}

// The same header and cell look as the orders and products tables of this section.
const CELL = 'p-2';
const NUM_CELL = `${CELL} text-right tabular-nums`;
const HEAD = 'font-normal p-2 text-left';

/**
 * The customer list, as the server counted it.
 *
 * Every column comes straight out of `figures` — the list endpoint's own
 * grouped query — and none of it is added up here (design decision 8). The
 * list figures deliberately carry no `printed`/`ordered`: those are the detail
 * endpoint's, and the customer page is where they are shown.
 *
 * The rows are one page of many, so a header sorts on the server (`sort_by`),
 * never just what is on screen.
 */
export function CustomersTable({ customers, onEdit, onDelete, sort, onSortChange, footer }: CustomersTableProps) {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const hasActions = hasPermission('projects:update') || hasPermission('projects:delete');
  // The app-wide currency, fetched the way every other money-showing screen
  // fetches it; `formatMoney` covers the unresolved first paint.
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings, staleTime: 60_000 });
  // Numbers read best largest-first; a name reads best A→Z.
  const numeric = (key: string, label: string) => (
    <SortableHeader sortKey={key} label={label} sort={sort} onSort={onSortChange} descFirst align="right" />
  );

  return (
    <div className="rounded-xl border border-bambu-dark-tertiary overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-bambu-gray bg-bambu-dark-secondary">
            <tr>
              <SortableHeader sortKey="name" label={t('customers.table.name')} sort={sort} onSort={onSortChange} />
              <th className={HEAD}>{t('customers.table.contact')}</th>
              {numeric('orders', t('customers.table.orders'))}
              {numeric('active', t('customers.table.active'))}
              {numeric('completed', t('customers.table.completed'))}
              {numeric('cancelled', t('customers.table.cancelled'))}
              {numeric('total_price', t('customers.table.totalPrice'))}
              {hasActions && <th className="p-2" aria-label={t('common.actions')} />}
            </tr>
          </thead>
          <tbody>
            {customers.map((customer) => (
              <tr key={customer.id} className="border-t border-bambu-dark-tertiary hover:bg-bambu-dark/40">
                <td className={CELL}>
                  <Link to={`/customers/${customer.id}`} className="text-white hover:text-bambu-green font-medium">
                    {customer.name}
                  </Link>
                </td>
                <td className={`${CELL} text-bambu-gray`}>{customer.contact ?? '—'}</td>
                <td className={`${NUM_CELL} text-white`}>{customer.figures.projects}</td>
                <td className={`${NUM_CELL} text-bambu-gray`}>{customer.figures.active}</td>
                <td className={`${NUM_CELL} text-bambu-gray`}>{customer.figures.completed}</td>
                <td className={`${NUM_CELL} text-bambu-gray`}>{customer.figures.cancelled}</td>
                <td className={`${NUM_CELL} text-white`}>
                  {formatMoney(customer.figures.total_price, settings?.currency)}
                </td>
                {hasActions && (
                  <td className={`${CELL} text-right`}>
                    <CustomerActions customer={customer} onEdit={onEdit} onDelete={onDelete} />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {footer}
    </div>
  );
}
