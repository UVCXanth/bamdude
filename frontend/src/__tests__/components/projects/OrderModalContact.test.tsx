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
    vi.spyOn(api, 'getCustomers').mockResolvedValue(customers as never);
  });

  it('is off without a customer, takes the main contact on choosing one and re-picks it on a switch', async () => {
    const create = vi.spyOn(api, 'createOrder').mockResolvedValue({ id: 9 } as never);
    render(<OrderModal onClose={() => {}} />);
    const contact = await screen.findByLabelText('Contact person');
    expect(contact).toBeDisabled();
    await screen.findByRole('option', { name: 'CU-0001 · ACME' });
    fireEvent.change(screen.getByLabelText('Customer'), { target: { value: '1' } });
    await waitFor(() => expect(contact).toHaveValue('10'));
    fireEvent.change(contact, { target: { value: '11' } });
    expect(contact).toHaveValue('11');
    fireEvent.change(screen.getByLabelText('Customer'), { target: { value: '2' } });
    await waitFor(() => expect(contact).toHaveValue('20'));
    fireEvent.change(screen.getByLabelText('Customer'), { target: { value: '3' } });
    await waitFor(() => expect(contact).toBeDisabled());
    fireEvent.change(screen.getByLabelText('Customer'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Lamps' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ customer_id: 1, contact_id: 10 })),
    );
  });
});
