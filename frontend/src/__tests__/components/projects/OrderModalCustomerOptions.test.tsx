/**
 * An order clerk who does not read the customers' directory still names an order's customer
 * and contact (WS-13 E13 R12): the picker reads `GET /customers/options` (id, code, name) and
 * the contact field `GET /customers/{id}/contact-options` (name, role) — never the directory,
 * which is personal data and answers them 403.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { render } from '../../utils';
import { api, ApiError } from '../../../api/client';
import { OrderModal } from '../../../components/projects/OrderModal';

describe('OrderModal · without the customers directory', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'getCustomers').mockRejectedValue(new ApiError('Missing required permissions: customers:read', 403));
    vi.spyOn(api, 'getCustomerOptions').mockResolvedValue([{ id: 1, code: 'CU-0001', name: 'ACME' }]);
    vi.spyOn(api, 'getContactOptions').mockResolvedValue([
      { id: 10, code: 'CT-0010', name: 'Olena', role: null },
      { id: 11, code: 'CT-0011', name: null, role: 'Warehouse' },
    ]);
  });

  it('names the customer and its contact from the pickers’ own reads', async () => {
    const create = vi.spyOn(api, 'createOrder').mockResolvedValue({ id: 9 } as never);
    render(<OrderModal onClose={() => {}} />);
    await screen.findByRole('option', { name: 'CU-0001 · ACME' });
    fireEvent.change(screen.getByLabelText('Customer'), { target: { value: '1' } });
    const contact = await screen.findByLabelText('Contact person');
    await waitFor(() => expect(contact).toHaveValue('10'));
    expect(screen.getByRole('option', { name: 'Warehouse' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Lamps' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ customer_id: 1, contact_id: 10 })));
    expect(api.getCustomers).not.toHaveBeenCalled();
  });
});
