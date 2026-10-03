/**
 * A customer as a card (WS-13 E11 D): the mockup's anatomy — the avatar, the code and the
 * type's badge on top; the name; «main +N · city»; the two figures; a footer with the main
 * contact's phone on the left and the menu on the right. The whole card opens the customer
 * through an overlay link, and the phone and the menu stay above it.
 */

import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { render } from '../../utils';
import type { Customer, CustomerContact } from '../../../api/client';
import { CustomerCard } from '../../../components/customers/CustomerCard';
import type { CustomerActionsHost } from '../../../components/customers/useCustomerActions';

const contact = (over: Partial<CustomerContact>): CustomerContact => ({
  id: 10,
  code: 'CT-0010',
  name: null,
  role: null,
  phone: null,
  email: null,
  city: null,
  delivery_method_id: null,
  delivery_method_name: null,
  delivery_details: null,
  note: null,
  orders_count: 0,
  ...over,
});

const customer = (over: Partial<Customer> = {}) =>
  ({
    id: 1,
    code: 'CU-0001',
    name: 'Світло Про',
    kind: 'regular',
    notes: null,
    contacts: [
      contact({ id: 10, name: 'Olena', phone: '+380 67 1', email: 'olena@acme.ua', city: 'Kyiv' }),
      contact({ id: 11, name: 'Serhii' }),
    ],
    figures: { projects: 3, active: 1, completed: 2, cancelled: 0, total_price: 450 },
    ...over,
  }) as unknown as Customer;

const actions: CustomerActionsHost = { available: () => ['edit', 'newOrder', 'delete'], run: vi.fn(), host: null };

function mount(c: Customer = customer()) {
  render(<CustomerCard customer={c} currency="USD" actions={actions} />);
  return screen.getByTestId(`customer-${c.id}-card`);
}

describe('CustomerCard', () => {
  it('top: the initials, the code and the type\'s badge; the name; «main +N · city»', () => {
    const card = mount();
    expect(within(card).getByText('СП')).toHaveAttribute('aria-hidden', 'true');
    expect(within(card).getByText('CU-0001')).toBeInTheDocument();
    expect(within(card).getByText('Regular')).toHaveClass('text-bambu-green');
    expect(within(card).getByRole('heading', { level: 3, name: 'Світло Про' })).toBeInTheDocument();
    expect(within(card).getByText('Olena +1 · Kyiv')).toBeInTheDocument();
  });

  it('two figures: orders with the active ones, and the sum', () => {
    const card = mount();
    const meta = within(card).getByTestId('customer-1-meta');
    expect(meta).toHaveTextContent('Orders');
    expect(meta).toHaveTextContent('3 · 1 active');
    expect(meta).toHaveTextContent('Total');
    expect(meta).toHaveTextContent('$450.00');
  });

  it('the footer: the main phone as a link on the left, the menu on the right', () => {
    const card = mount();
    const footer = within(card).getByTestId('customer-1-footer');
    expect(within(footer).getByRole('link', { name: '+380 67 1' })).toHaveAttribute('href', 'tel:+380671');
    expect(within(footer).getByRole('button', { name: 'Actions for Світло Про' })).toBeInTheDocument();
  });

  it('no phone — the e-mail; neither — nothing on the left', () => {
    const noPhone = mount(customer({ id: 2, contacts: [contact({ name: 'Olena', email: 'olena@acme.ua' })] }));
    expect(within(within(noPhone).getByTestId('customer-2-footer')).getByRole('link', { name: 'olena@acme.ua' })).toHaveAttribute(
      'href',
      'mailto:olena@acme.ua',
    );
    const neither = mount(customer({ id: 3, contacts: [contact({ name: 'Olena' })] }));
    expect(within(within(neither).getByTestId('customer-3-footer')).queryByRole('link')).not.toBeInTheDocument();
  });

  it('no contacts says so', () => {
    const card = mount(customer({ id: 4, contacts: [] }));
    expect(within(card).getByText('No contacts')).toBeInTheDocument();
  });

  it('the whole card opens the customer; the phone and the menu are not inside that link', () => {
    const card = mount();
    const open = within(card).getByRole('link', { name: 'Світло Про' });
    expect(open).toHaveAttribute('href', '/customers/1');
    expect(open).toHaveClass('absolute', 'inset-0');
    expect(open.querySelector('a, button')).toBeNull();
    const phone = within(card).getByRole('link', { name: '+380 67 1' });
    expect(phone.closest('.relative.z-10')).not.toBeNull();
    expect(within(card).getByRole('button', { name: 'Actions for Світло Про' }).closest('.relative.z-10')).not.toBeNull();
  });
});
