import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { render } from '../../utils';
import { api } from '../../../api/client';
import { OrderModal } from '../../../components/projects/OrderModal';

const blank = {
  role: null,
  phone: null,
  email: null,
  city: null,
  delivery_method_id: null,
  delivery_method_name: null,
  delivery_details: null,
  note: null,
  orders_count: 0,
};
const customer = (id: number, name: string, contacts: unknown[]) => ({
  id,
  code: `CU-000${id}`,
  name,
  kind: 'company',
  notes: null,
  created_at: '',
  updated_at: '',
  figures: {},
  contacts,
});
const customers = [
  customer(1, 'ACME', [
    { ...blank, id: 10, code: 'CT-0010', name: 'Olena' },
    { ...blank, id: 11, code: 'CT-0011', name: 'Serhii' },
  ]),
  customer(2, 'Beta', [{ ...blank, id: 20, code: 'CT-0020', name: 'Ira' }]),
  customer(3, 'Gamma', []),
];

describe('OrderModal · contact person', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'getCustomerOptions').mockResolvedValue(customers as never);
    // The contact field reads the chosen customer's contact options (WS-13 E13 R12).
    vi.spyOn(api, 'getContactOptions').mockImplementation(
      async (id: number) => (customers.find((c) => c.id === id)?.contacts ?? []) as never,
    );
  });

  it('appears with a customer, takes the main contact on choosing one and re-picks it on a switch', async () => {
    const create = vi.spyOn(api, 'createOrder').mockResolvedValue({ id: 9 } as never);
    render(<OrderModal onClose={() => {}} />);
    await screen.findByRole('option', { name: 'CU-0001 · ACME' });
    // Without a customer there is no contact to name — the field is not there (WS-13 E6 C02).
    expect(screen.queryByLabelText('Contact person')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Customer'), { target: { value: '1' } });
    const contact = await screen.findByLabelText('Contact person');
    await waitFor(() => expect(contact).toHaveValue('10'));
    fireEvent.change(contact, { target: { value: '11' } });
    expect(contact).toHaveValue('11');
    fireEvent.change(screen.getByLabelText('Customer'), { target: { value: '2' } });
    await waitFor(() => expect(contact).toHaveValue('20'));
    fireEvent.change(screen.getByLabelText('Customer'), { target: { value: '3' } });
    await waitFor(() => expect(contact).toBeDisabled());
    fireEvent.change(screen.getByLabelText('Customer'), { target: { value: '1' } });
    await waitFor(() => expect(contact).toHaveValue('10'));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Lamps' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ customer_id: 1, contact_id: 10 })),
    );
  });

  it('names a nameless contact by its role — once — as the customer pages do', async () => {
    const delta = customer(4, 'Delta', [
      { ...blank, id: 40, code: 'CT-0040', name: null, role: 'Warehouse' },
      { ...blank, id: 41, code: 'CT-0041', name: 'Ira', role: 'Buyer' },
    ]);
    vi.spyOn(api, 'getCustomerOptions').mockResolvedValue([delta] as never);
    vi.spyOn(api, 'getContactOptions').mockResolvedValue(delta.contacts as never);
    render(<OrderModal defaultCustomerId={4} onClose={() => {}} />);
    expect(await screen.findByRole('option', { name: 'Warehouse' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Ira — Buyer' })).toBeInTheDocument();
  });

  it('an order opened from a list row is read in full, so its contact can be edited (WS-13 E6 C07)', async () => {
    vi.spyOn(api, 'getOrder').mockResolvedValue({
      id: 5, code: 'OR-0005', name: 'Lamps', customer_id: 1, customer_name: 'ACME', contact_id: 11,
      color: null, status: 'active', tags: null, due_date: null, priority: 'normal', price: null, url: null,
      description: null, responsible_id: null, responsible_name: null, figures: {}, lines: [],
    } as never);
    render(<OrderModal orderId={5} onClose={() => {}} />);
    const contact = await screen.findByLabelText('Contact person');
    await waitFor(() => expect(contact).toHaveValue('11'));
  });
});
