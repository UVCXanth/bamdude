/**
 * A contact's phone and e-mail as links (security review of WS-13 E11): the address is
 * typed by hand and the server stores it as written, so a `?`, `&` or `#` in it must not
 * add a recipient, a subject or a body to the letter the click opens. Every place that
 * links a contact uses the same two builders.
 */

import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { render } from '../../utils';
import type { Customer, CustomerContact } from '../../../api/client';
import { mailtoHref, telHref } from '../../../components/customers/contactFormat';
import { ContactReach } from '../../../components/customers/ContactReach';
import { CustomerCard } from '../../../components/customers/CustomerCard';
import type { CustomerActionsHost } from '../../../components/customers/useCustomerActions';

const hostile = 'olena@acme.ua?bcc=spy@evil.example&subject=hi#x';

const contact = (over: Partial<CustomerContact>): CustomerContact => ({
  id: 10,
  code: 'CT-0010',
  name: 'Olena',
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

describe('contact links', () => {
  it('a mailto keeps the address readable and turns ? & # into text, never into fields', () => {
    expect(mailtoHref('olena@acme.ua')).toBe('mailto:olena@acme.ua');
    const href = mailtoHref(hostile);
    expect(href.startsWith('mailto:olena@acme.ua')).toBe(true);
    expect(href.slice('mailto:'.length)).not.toMatch(/[?&#]/);
  });

  it('a tel keeps only the digits and the plus', () => {
    expect(telHref('+380 (67) 120-44-11')).toBe('tel:+380671204411');
  });

  it('ContactReach and the card link through them', () => {
    render(<ContactReach contact={contact({ email: hostile })} />);
    expect(screen.getByRole('link', { name: hostile })).toHaveAttribute('href', mailtoHref(hostile));
    const customer = {
      id: 1,
      code: 'CU-0001',
      name: 'ACME',
      kind: 'company',
      notes: null,
      contacts: [contact({ email: hostile })],
      figures: { projects: 0, active: 0, completed: 0, cancelled: 0, total_price: 0 },
    } as unknown as Customer;
    const actions: CustomerActionsHost = { available: () => [], run: vi.fn(), host: null };
    render(<CustomerCard customer={customer} actions={actions} />);
    const footer = screen.getByTestId('customer-1-footer');
    expect(within(footer).getByRole('link', { name: hostile })).toHaveAttribute('href', mailtoHref(hostile));
  });
});
