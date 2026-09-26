import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { render } from '../../utils';
import { api } from '../../../api/client';
import type { Customer } from '../../../api/client';
import { CustomerModal } from '../../../components/customers/CustomerModal';

const blank = {
  role: null,
  phone: null,
  email: null,
  city: null,
  delivery_method_id: null,
  delivery_method_name: null,
  delivery_details: null,
  note: null,
};
const acme: Customer = {
  id: 1,
  code: 'CU-0001',
  name: 'ACME',
  kind: 'company',
  notes: null,
  created_at: '',
  updated_at: '',
  contacts: [
    { ...blank, id: 10, code: 'CT-0010', name: 'Olena', orders_count: 0 },
    { ...blank, id: 11, code: 'CT-0011', name: 'Serhii', orders_count: 2 },
  ],
  figures: { projects: 0, active: 0, completed: 0, cancelled: 0, total_price: 0 },
};

describe('CustomerModal', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'getDeliveryMethods').mockResolvedValue([
      { id: 7, name: 'Nova Poshta', position: 0, contacts_count: 1 },
    ]);
  });

  it('a new customer starts with one empty contact and sends kind, notes and the filled rows', async () => {
    const create = vi.spyOn(api, 'createCustomer').mockResolvedValue({ ...acme, id: 2 });
    render(<CustomerModal onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Beta' } });
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'regular' } });
    const rows = screen.getAllByTestId('contact-row');
    expect(rows).toHaveLength(1);
    fireEvent.change(within(rows[0]).getByLabelText('Contact name'), { target: { value: ' Ira ' } });
    await within(rows[0]).findByRole('option', { name: 'Nova Poshta' });
    fireEvent.change(within(rows[0]).getByLabelText('Delivery method'), { target: { value: '7' } });
    fireEvent.change(within(rows[0]).getByLabelText('Delivery details'), { target: { value: 'branch 5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add contact' })); // a second, left empty: not sent
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        name: 'Beta',
        kind: 'regular',
        notes: null,
        contacts: [
          {
            name: 'Ira',
            role: null,
            phone: null,
            email: null,
            city: null,
            delivery_method_id: 7,
            delivery_details: 'branch 5',
            note: null,
          },
        ],
      }),
    );
  });

  it('«Make main» moves a row to the top and the save keeps ids in the new order', async () => {
    const update = vi.spyOn(api, 'updateCustomer').mockResolvedValue(acme);
    render(<CustomerModal customer={acme} onClose={() => {}} />);
    const second = screen.getAllByTestId('contact-row')[1];
    fireEvent.click(within(second).getByRole('button', { name: 'Make main' }));
    expect(within(screen.getAllByTestId('contact-row')[0]).getByLabelText('Contact name')).toHaveValue('Serhii');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][1].contacts!.map((c) => c.id)).toEqual([11, 10]);
  });

  it('removing a contact orders name asks first and warns what happens', async () => {
    const update = vi.spyOn(api, 'updateCustomer').mockResolvedValue(acme);
    render(<CustomerModal customer={acme} onClose={() => {}} />);
    const linked = screen.getAllByTestId('contact-row')[1];
    fireEvent.click(within(linked).getByRole('button', { name: 'Remove contact' }));
    expect(within(linked).getByText('Linked to 2 orders — they will lose their contact')).toBeInTheDocument();
    fireEvent.click(within(linked).getByRole('button', { name: 'Remove anyway' }));
    expect(screen.getAllByTestId('contact-row')).toHaveLength(1);
    const free = screen.getAllByTestId('contact-row')[0];
    fireEvent.click(within(free).getByRole('button', { name: 'Remove contact' })); // unlinked: at once
    expect(screen.queryAllByTestId('contact-row')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(update.mock.calls[0][1].contacts).toEqual([]));
  });

  it('opens the delivery reference from a contact row', async () => {
    render(<CustomerModal customer={acme} onClose={() => {}} />);
    fireEvent.click(within(screen.getAllByTestId('contact-row')[0]).getByRole('button', { name: 'Manage methods…' }));
    expect(await screen.findByRole('dialog', { name: 'Delivery methods' })).toBeInTheDocument();
  });
});
