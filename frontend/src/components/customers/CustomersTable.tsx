import { Fragment, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '../../api/client';
import type { Customer } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { formatMoney } from '../../utils/currency';
import { SortableHeader } from '../SortableHeader';
import { CustomerActions } from './CustomerActions';
import { ContactReach } from './ContactReach';
import { contactTitle, deliveryLine } from './contactFormat';

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
 * never just what is on screen. The main contact is `contacts[0]` as the server
 * ordered them; a row with more than one opens to all of them — locally, per
 * row, since the contacts already came with the page (spec workshop-customers, rule 21).
 */
export function CustomersTable({ customers, onEdit, onDelete, sort, onSortChange, footer }: CustomersTableProps) {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const hasActions = hasPermission('projects:update') || hasPermission('projects:delete');
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  const toggle = (id: number) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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
              <th className="w-8 p-2" aria-hidden />
              <SortableHeader sortKey="name" label={t('customers.table.name')} sort={sort} onSort={onSortChange} />
              <th className={HEAD}>{t('customers.table.contact')}</th>
              <th className={HEAD}>{t('customers.table.delivery')}</th>
              {numeric('orders', t('customers.table.orders'))}
              {numeric('active', t('customers.table.active'))}
              {numeric('completed', t('customers.table.completed'))}
              {numeric('cancelled', t('customers.table.cancelled'))}
              {numeric('total_price', t('customers.table.totalPrice'))}
              {hasActions && <th className="p-2" aria-label={t('common.actions')} />}
            </tr>
          </thead>
          <tbody>
            {customers.map((customer) => {
              const main = customer.contacts[0];
              const many = customer.contacts.length > 1;
              const isOpen = many && open.has(customer.id);
              return (
                <Fragment key={customer.id}>
                  <tr
                    data-testid={`customer-${customer.id}-row`}
                    className="border-t border-bambu-dark-tertiary hover:bg-bambu-dark/40"
                  >
                    <td className="p-2 align-top">
                      {many && (
                        <button
                          type="button"
                          onClick={() => toggle(customer.id)}
                          aria-expanded={isOpen}
                          aria-label={t('customers.contacts.all')}
                          className="text-bambu-gray hover:text-white"
                        >
                          {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                        </button>
                      )}
                    </td>
                    <td className={CELL}>
                      <Link to={`/customers/${customer.id}`} className="text-white hover:text-bambu-green font-medium">
                        {customer.name}
                      </Link>
                      <div className="text-xs text-bambu-gray">{`${t(`customers.kind.${customer.kind}`)} · ${customer.code}`}</div>
                    </td>
                    <td className={`${CELL} text-bambu-gray`}>
                      {main ? (
                        <>
                          <div className="text-white">{contactTitle(main)}</div>
                          <ContactReach contact={main} className="text-xs" />
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className={`${CELL} text-bambu-gray`}>{(main && deliveryLine(main)) || '—'}</td>
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
                  {isOpen && (
                    <tr className="bg-bambu-dark/30">
                      <td />
                      {/* Every column but the chevron: name, contact, delivery, five numbers, and the actions. */}
                      <td colSpan={hasActions ? 9 : 8} className="p-2">
                        <table data-testid={`customer-${customer.id}-contacts`} className="w-full text-xs">
                          <tbody>
                            {customer.contacts.map((c, index) => (
                              <tr key={c.id} className="border-t border-bambu-dark-tertiary/50">
                                <td className="p-1.5 text-bambu-gray">{c.code}</td>
                                <td className="p-1.5 text-white">
                                  {contactTitle(c)}
                                  {index === 0 && (
                                    <span className="ml-1.5 px-1.5 py-0.5 rounded text-[10px] bg-bambu-green/15 text-bambu-green">
                                      {t('customers.contacts.main')}
                                    </span>
                                  )}
                                  {c.note && <div className="text-bambu-gray">{c.note}</div>}
                                </td>
                                <td className="p-1.5 text-bambu-gray">{c.role ?? '—'}</td>
                                <td className="p-1.5 text-bambu-gray">
                                  <ContactReach contact={c} />
                                </td>
                                <td className="p-1.5 text-bambu-gray">{deliveryLine(c) || '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {footer}
    </div>
  );
}
