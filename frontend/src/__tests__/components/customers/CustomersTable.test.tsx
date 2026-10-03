/**
 * The customers table (WS-13 E11 C): the mockup's seven columns — the expander, the
 * customer (avatar, name, «type · code»), the main contact with «+ N» that opens the same
 * row as the expander, city and delivery, ONE grouped orders cell, the sum, the menu —
 * and the row that opens to every contact.
 */

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { render } from '../../utils';
import type { Customer, CustomerContact } from '../../../api/client';
import { CustomersTable } from '../../../components/customers/CustomersTable';
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

const acme = {
  id: 1,
  code: 'CU-0001',
  name: 'Світло Про',
  kind: 'regular',
  notes: null,
  contacts: [
    contact({
      id: 10,
      code: 'CT-0010',
      name: 'Olena',
      role: 'Purchasing',
      phone: '+380 67 1',
      email: 'olena@acme.ua',
      city: 'Kyiv',
      delivery_method_name: 'Nova Poshta',
      delivery_details: 'branch 12',
    }),
    contact({ id: 11, code: 'CT-0011', name: 'Serhii', role: 'Warehouse', note: 'mornings\nonly' }),
  ],
  figures: { projects: 3, active: 1, completed: 2, cancelled: 0, total_price: 450 },
} as unknown as Customer;

const bare = {
  ...acme,
  id: 2,
  code: 'CU-0002',
  name: 'Bare',
  kind: 'company',
  contacts: [],
  figures: { projects: 0, active: 0, completed: 0, cancelled: 0, total_price: 0 },
} as unknown as Customer;

const actions: CustomerActionsHost = { available: () => ['edit', 'newOrder', 'delete'], run: vi.fn(), host: null };

function mount(customers: Customer[] = [acme]) {
  render(<CustomersTable customers={customers} actions={actions} sort="name-asc" onSortChange={vi.fn()} />);
}

describe('CustomersTable', () => {
  it('seven columns in the mockup\'s order, inside its own scroll', async () => {
    mount();
    const region = await screen.findByRole('region', { name: 'Customers' });
    // The sort arrow is decoration beside the header's own words.
    const headers = within(region)
      .getAllByRole('columnheader')
      .map((th) => th.textContent?.replace(/[▲▼]/g, '').trim());
    // The expander's column has no header a reader is told about (it is `aria-hidden`).
    expect(headers).toEqual(['Customer', 'Contacts', 'City · delivery', 'Orders', 'Total price', 'Actions']);
  });

  it('the customer: its initials, the name as a link, «type · code»', async () => {
    mount();
    const row = await screen.findByTestId('customer-1-row');
    expect(within(row).getByText('СП')).toHaveAttribute('aria-hidden', 'true');
    expect(within(row).getByRole('link', { name: 'Світло Про' })).toHaveAttribute('href', '/customers/1');
    expect(within(row).getByText('Regular · CU-0001')).toBeInTheDocument();
  });

  it('the main contact with its role, its phone and e-mail as links, and «+ N» opening the row', async () => {
    mount();
    const row = await screen.findByTestId('customer-1-row');
    expect(within(row).getByText('Olena')).toBeInTheDocument();
    expect(within(row).getByText('· Purchasing')).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: '+380 67 1' })).toHaveAttribute('href', 'tel:+380671');
    expect(within(row).getByRole('link', { name: 'olena@acme.ua' })).toHaveAttribute('href', 'mailto:olena@acme.ua');
    const more = within(row).getByRole('button', { name: '+ 1 contact' });
    const chevron = within(row).getByRole('button', { name: 'All contacts of Світло Про' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    // «+ N» and the chevron are one state of the row.
    fireEvent.click(more);
    expect(await screen.findByTestId('customer-1-contacts')).toBeInTheDocument();
    expect(chevron).toHaveAttribute('aria-expanded', 'true');
    expect(more).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(chevron);
    expect(screen.queryByTestId('customer-1-contacts')).not.toBeInTheDocument();
  });

  it('«+ N» is described by its customer — the same words stand in every row', async () => {
    mount();
    const row = await screen.findByTestId('customer-1-row');
    expect(within(row).getByRole('button', { name: '+ 1 contact' })).toHaveAccessibleDescription('Світло Про');
  });

  it('city, then the delivery method and its details', async () => {
    mount();
    const cell = within(await screen.findByTestId('customer-1-row')).getByTestId('customer-1-delivery');
    expect(cell).toHaveTextContent('Kyiv');
    expect(within(cell).getByText('Nova Poshta · branch 12')).toBeInTheDocument();
  });

  it('ONE grouped orders cell: total, the active badge, completed · cancelled', async () => {
    mount([acme, bare]);
    const cell = within(await screen.findByTestId('customer-1-row')).getByTestId('customer-1-orders');
    expect(cell).toHaveTextContent('3 total');
    expect(within(cell).getByText('1 active')).toBeInTheDocument();
    expect(cell).toHaveTextContent('2 completed · 0 cancelled');
    // No badge for no active order.
    expect(within(screen.getByTestId('customer-2-orders')).queryByText(/active/)).not.toBeInTheDocument();
  });

  it('nothing to say is a dash — contact, city, delivery — and no «+ N» or expander', async () => {
    mount([bare]);
    const row = await screen.findByTestId('customer-2-row');
    expect(within(row).getAllByText('—').length).toBeGreaterThanOrEqual(2);
    expect(within(row).queryByRole('button', { name: /All contacts|\+ \d/ })).not.toBeInTheDocument();
  });

  it('the open row lists every contact: the main mark, the code, role, e-mail, phone, delivery and note', async () => {
    mount();
    fireEvent.click(within(await screen.findByTestId('customer-1-row')).getByRole('button', { name: '+ 1 contact' }));
    const all = await screen.findByTestId('customer-1-contacts');
    expect(within(all).getAllByRole('columnheader').map((th) => th.textContent?.trim())).toEqual([
      'Contact',
      'Role',
      'Email',
      'Phone',
      'City · delivery',
      'Note',
    ]);
    const rows = within(all).getAllByRole('row').slice(1);
    expect(within(rows[0]).getByText('main')).toBeInTheDocument();
    expect(within(rows[0]).getByText('CT-0010')).toBeInTheDocument();
    expect(within(rows[0]).getByRole('link', { name: 'olena@acme.ua' })).toBeInTheDocument();
    expect(within(rows[0]).getByText('Kyiv · Nova Poshta · branch 12')).toBeInTheDocument();
    expect(within(rows[1]).queryByText('main')).not.toBeInTheDocument();
    expect(within(rows[1]).getByText('Warehouse')).toBeInTheDocument();
    expect(within(rows[1]).getByText(/mornings/)).toHaveClass('whitespace-pre-line');
  });

  it('the menu of the row', async () => {
    mount();
    expect(
      within(await screen.findByTestId('customer-1-row')).getByRole('button', { name: 'Actions for Світло Про' }),
    ).toBeInTheDocument();
  });
});
