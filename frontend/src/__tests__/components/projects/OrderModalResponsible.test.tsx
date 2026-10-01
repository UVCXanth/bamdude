import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { render } from '../../utils';
import { api } from '../../../api/client';
import { OrderModal } from '../../../components/projects/OrderModal';

// The msw user is id 1, «admin» (__tests__/mocks/handlers.ts, /auth/me).
const assignees = [
  { id: 1, username: 'admin' },
  { id: 7, username: 'ira' },
];

describe('OrderModal · responsible', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'getCustomers').mockResolvedValue([] as never);
    vi.spyOn(api, 'getOrderAssignees').mockResolvedValue(assignees);
  });

  it('a new order is the signed-in user’s unless another is chosen', async () => {
    const create = vi.spyOn(api, 'createOrder').mockResolvedValue({ id: 9 } as never);
    render(<OrderModal onClose={() => {}} />);
    const select = await screen.findByLabelText('Responsible');
    await screen.findByRole('option', { name: 'ira' });
    await waitFor(() => expect(select).toHaveValue('1'));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Lamps' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ responsible_id: 1 })));
  });

  it('«Not assigned» sends nobody', async () => {
    // A created order opens at once (WS-13 E6 C09), so the second case is a form of its own.
    const create = vi.spyOn(api, 'createOrder').mockResolvedValue({ id: 9 } as never);
    render(<OrderModal onClose={() => {}} />);
    const select = await screen.findByLabelText('Responsible');
    await screen.findByRole('option', { name: 'ira' });
    fireEvent.change(select, { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Lamps' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ responsible_id: null })));
  });

  it('keeps a responsible who is no longer active, and sends nothing when untouched', async () => {
    const update = vi.spyOn(api, 'updateOrder').mockResolvedValue({ id: 5 } as never);
    const order = {
      id: 5,
      name: 'Old',
      customer_id: null,
      status: 'active',
      priority: 'normal',
      responsible_id: 9,
      responsible_name: 'gone',
    } as never;
    const onClose = vi.fn();
    render(<OrderModal order={order} onClose={onClose} />);
    const select = await screen.findByLabelText('Responsible');
    await screen.findByRole('option', { name: 'ira' });
    expect(screen.getByRole('option', { name: 'gone' })).toBeInTheDocument();
    expect(select).toHaveValue('9');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    // An untouched edit sends no request at all (WS-13 E6 C05).
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(update).not.toHaveBeenCalled();
  });
});
