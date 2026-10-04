import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { Customer } from '../../api/client';
import { formatMoney } from '../../utils/currency';
import { CustomerActionMenu } from './CustomerActionMenu';
import { CustomerAvatar } from './CustomerAvatar';
import type { CustomerActionsHost } from './useCustomerActions';
import { contactTitle, mailtoHref, telHref } from './contactFormat';

/**
 * One customer as a card — the second view of the customers page (WS-13 E11 D, the
 * mockup's `customerCard`): the avatar, the code and the type's badge; the name; «main +N ·
 * city»; the orders and the sum, the list endpoint's own light figures (nothing added up
 * here); a footer with the main contact's phone — else its e-mail — and the menu.
 *
 * The whole card opens the customer through an overlay link named by the customer (E8-E02);
 * the phone, the e-mail and the menu sit above it (`relative z-10`), so their clicks are
 * their own. The card is a flex column, so the footers of one row line up.
 */
export function CustomerCard({
  customer,
  currency,
  actions,
}: {
  customer: Customer;
  currency?: string;
  actions: CustomerActionsHost;
}) {
  const { t } = useTranslation();
  const { figures } = customer;
  // The server orders the contacts; the first is the main one (spec workshop-customers, rule 21).
  const main = customer.contacts[0];
  const who = main
    ? [`${contactTitle(main)}${customer.contacts.length > 1 ? ` +${customer.contacts.length - 1}` : ''}`, main.city]
        .filter(Boolean)
        .join(' · ')
    : t('customers.contacts.none');
  return (
    <article
      data-testid={`customer-${customer.id}-card`}
      className="relative flex h-full flex-col rounded-xl bg-bambu-dark-secondary border border-bambu-dark-tertiary hover:border-bambu-green/50 p-4"
    >
      <div className="flex items-center justify-between gap-2 mb-3">
        <CustomerAvatar name={customer.name} />
        <span className="text-xs text-bambu-gray">{customer.code}</span>
        <span
          className={`ml-auto px-1.5 py-0.5 rounded text-xs ${
            customer.kind === 'regular' ? 'bg-bambu-green/15 text-bambu-green' : 'bg-bambu-dark text-bambu-gray'
          }`}
        >
          {t(`customers.kind.${customer.kind}`)}
        </span>
      </div>
      <h3 className="text-base font-semibold text-white break-words mb-0.5">{customer.name}</h3>
      <p className="text-xs text-bambu-gray break-words">{who}</p>
      <dl data-testid={`customer-${customer.id}-meta`} className="grid grid-cols-2 gap-2.5 my-3.5">
        <div>
          <dt className="text-xs text-bambu-gray">{t('customers.card.orders')}</dt>
          <dd className="text-sm text-white tabular-nums">
            {/* The orders' figures are the orders' — «—» without their read (WS-13 E13 O12). */}
            {figures ? t('customers.card.ordersValue', { total: figures.projects, active: figures.active }) : '—'}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-bambu-gray">{t('customers.card.total')}</dt>
          <dd className="text-sm text-white tabular-nums">{figures ? formatMoney(figures.total_price, currency) : '—'}</dd>
        </div>
      </dl>
      <div
        data-testid={`customer-${customer.id}-footer`}
        className="mt-auto flex items-center justify-between gap-2 border-t border-bambu-dark-tertiary pt-2.5"
      >
        <span className="relative z-10 min-w-0 text-xs text-bambu-gray break-words">
          {main?.phone ? (
            <a href={telHref(main.phone)} className="hover:text-white">
              {main.phone}
            </a>
          ) : main?.email ? (
            <a href={mailtoHref(main.email)} className="hover:text-white">
              {main.email}
            </a>
          ) : null}
        </span>
        <span className="relative z-10">
          <CustomerActionMenu customer={customer} actions={actions} />
        </span>
      </div>
      <Link
        to={`/customers/${customer.id}`}
        aria-label={customer.name}
        className="absolute inset-0 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green"
      />
    </article>
  );
}
