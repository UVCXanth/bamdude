import { Fragment, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '../../api/client';
import type { Customer, CustomerContact } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { formatMoney } from '../../utils/currency';
import { SortableHeader } from '../SortableHeader';
import { WorkshopPanel, WorkshopTableScroll } from '../workshop/WorkshopPanel';
import { CustomerActionMenu } from './CustomerActionMenu';
import { CustomerAvatar } from './CustomerAvatar';
import type { CustomerActionsHost } from './useCustomerActions';
import { ContactReach } from './ContactReach';
import { contactTitle, deliveryLine, mailtoHref, methodLine, telHref } from './contactFormat';

interface CustomersTableProps {
  customers: Customer[];
  actions: CustomerActionsHost;
  /** The list's `sort_by`; the headers ask the SERVER to sort. */
  sort: string;
  onSortChange: (sortBy: string) => void;
  /** The page bar, drawn inside the same panel under the rows. */
  footer?: ReactNode;
}

const MAIN_BADGE = 'ml-1.5 px-1.5 py-0.5 rounded text-[10px] bg-bambu-green/15 text-bambu-green';

/**
 * The customer list, as the server counted it (WS-13 E11 C) — the mockup's seven columns:
 * the expander, the customer, the main contact, city and delivery, ONE grouped orders cell,
 * the sum and the menu.
 *
 * Every figure comes straight out of `figures` — the list endpoint's own grouped query —
 * and none of it is added up here (inv-workshop-lists-and-figures-on-the-server). The rows
 * are one page of many, so a header sorts on the server (`sort_by`). The main contact is
 * `contacts[0]` as the server ordered them; a row with more than one opens to all of them —
 * by its chevron or by «+ N», one state per row, locally, since the contacts came with the page.
 */
export function CustomersTable({ customers, actions, sort, onSortChange, footer }: CustomersTableProps) {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const hasActions =
    hasPermission('projects:update') || hasPermission('projects:create') || hasPermission('projects:delete');
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
  const plain = (label: string) => <th className="font-normal text-left">{label}</th>;
  const columns = hasActions ? 7 : 6;

  return (
    <WorkshopPanel flush footer={footer}>
      <WorkshopTableScroll label={t('customers.list.title')}>
        <table className="w-full text-sm">
          <thead className="text-xs text-bambu-gray bg-bambu-dark-secondary [&_th]:px-3 max-[1024px]:[&_th]:px-2 [&_th]:py-2">
            <tr>
              <th className="w-8" aria-hidden />
              <SortableHeader sortKey="name" label={t('customers.table.name')} sort={sort} onSort={onSortChange} />
              {plain(t('customers.table.contact'))}
              {plain(t('customers.table.delivery'))}
              <SortableHeader
                sortKey="orders"
                label={t('customers.table.orders')}
                sort={sort}
                onSort={onSortChange}
                descFirst
              />
              <SortableHeader
                sortKey="total_price"
                label={t('customers.table.totalPrice')}
                sort={sort}
                onSort={onSortChange}
                descFirst
                align="right"
              />
              {hasActions && (
                <th className="w-[1%]">
                  <span className="sr-only">{t('common.actions')}</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody className="[&_td]:px-3 max-[1024px]:[&_td]:px-2 [&_td]:py-2.5 [&_td]:align-top">
            {customers.map((customer) => {
              const main = customer.contacts[0];
              const extra = customer.contacts.length - 1;
              const isOpen = extra > 0 && open.has(customer.id);
              const method = main ? methodLine(main) : '';
              return (
                <Fragment key={customer.id}>
                  <tr
                    data-testid={`customer-${customer.id}-row`}
                    className="border-t border-bambu-dark-tertiary hover:bg-bambu-dark/40"
                  >
                    <td className="w-8 !pr-0">
                      {extra > 0 && (
                        <button
                          type="button"
                          onClick={() => toggle(customer.id)}
                          aria-expanded={isOpen}
                          aria-label={t('customers.contacts.allOf', { name: customer.name })}
                          className="p-1 rounded text-bambu-gray hover:text-white"
                        >
                          {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                        </button>
                      )}
                    </td>
                    <td>
                      <div className="flex items-start gap-3">
                        <CustomerAvatar name={customer.name} />
                        <div className="min-w-0">
                          <Link
                            to={`/customers/${customer.id}`}
                            className="text-white hover:text-bambu-green font-medium break-words"
                          >
                            {customer.name}
                          </Link>
                          <div className="text-xs text-bambu-gray">{`${t(`customers.kind.${customer.kind}`)} · ${customer.code}`}</div>
                        </div>
                      </div>
                    </td>
                    <td className="text-bambu-gray">
                      {main ? (
                        <>
                          <div className="text-white">
                            {contactTitle(main)}
                            {main.name && main.role && <span className="text-bambu-gray"> · {main.role}</span>}
                          </div>
                          <ContactReach contact={main} className="block text-xs" />
                          {extra > 0 && (
                            <button
                              type="button"
                              onClick={() => toggle(customer.id)}
                              aria-expanded={isOpen}
                              className="text-xs text-bambu-green underline"
                            >
                              {t('customers.table.moreContacts', { count: extra })}
                            </button>
                          )}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td data-testid={`customer-${customer.id}-delivery`} className="text-bambu-gray">
                      {main?.city || method ? (
                        <>
                          <div className="text-white">{main?.city || '—'}</div>
                          {method && <div className="text-xs">{method}</div>}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    {/* Its lines are short and never broken: a long name takes the width. */}
                    <td data-testid={`customer-${customer.id}-orders`} className="text-bambu-gray whitespace-nowrap">
                      <div>
                        <span className="text-white tabular-nums">{customer.figures.projects}</span>{' '}
                        {t('customers.table.total')}
                        {customer.figures.active > 0 && (
                          <span className="ml-1.5 px-1.5 py-0.5 rounded text-[11px] bg-bambu-green/15 text-bambu-green">
                            {t('customers.table.activeBadge', { count: customer.figures.active })}
                          </span>
                        )}
                      </div>
                      <div className="text-xs">
                        {t('customers.table.doneLine', {
                          completed: customer.figures.completed,
                          cancelled: customer.figures.cancelled,
                        })}
                      </div>
                    </td>
                    <td className="text-right tabular-nums text-white">
                      {formatMoney(customer.figures.total_price, settings?.currency)}
                    </td>
                    {hasActions && (
                      <td className="text-right">
                        <CustomerActionMenu customer={customer} actions={actions} />
                      </td>
                    )}
                  </tr>
                  {isOpen && (
                    <tr className="bg-bambu-dark-tertiary/30">
                      <td />
                      <td colSpan={columns - 1}>
                        <ContactsTable customerId={customer.id} contacts={customer.contacts} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </WorkshopTableScroll>
    </WorkshopPanel>
  );
}

/** Every contact of one customer — the open row (C08): the mockup's columns, the code and the note. */
function ContactsTable({ customerId, contacts }: { customerId: number; contacts: CustomerContact[] }) {
  const { t } = useTranslation();
  return (
    <table data-testid={`customer-${customerId}-contacts`} className="w-full text-[13px] my-1.5">
      <thead className="text-xs text-bambu-gray [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:font-normal [&_th]:text-left">
        <tr>
          <th>{t('customers.table.mini.contact')}</th>
          <th>{t('customers.table.mini.role')}</th>
          <th>{t('customers.table.mini.email')}</th>
          <th>{t('customers.table.mini.phone')}</th>
          <th>{t('customers.table.mini.delivery')}</th>
          <th>{t('customers.table.mini.note')}</th>
        </tr>
      </thead>
      <tbody className="[&_td]:!px-2.5 [&_td]:!py-1.5 text-bambu-gray">
        {contacts.map((c, index) => (
          <tr key={c.id} className="border-t border-bambu-dark-tertiary/50">
            <td className="text-white">
              {contactTitle(c)}
              {index === 0 && <span className={MAIN_BADGE}>{t('customers.contacts.main')}</span>}
              <div className="text-xs text-bambu-gray">{c.code}</div>
            </td>
            <td>{c.role || '—'}</td>
            <td>
              {c.email ? (
                <a href={mailtoHref(c.email)} className="hover:text-white">
                  {c.email}
                </a>
              ) : (
                '—'
              )}
            </td>
            <td>
              {c.phone ? (
                <a href={telHref(c.phone)} className="hover:text-white">
                  {c.phone}
                </a>
              ) : (
                '—'
              )}
            </td>
            <td>{deliveryLine(c) || '—'}</td>
            <td>{c.note ? <span className="whitespace-pre-line">{c.note}</span> : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
