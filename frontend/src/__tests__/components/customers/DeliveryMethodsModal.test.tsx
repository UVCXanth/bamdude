import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { render } from '../../utils';
import { api } from '../../../api/client';
import { DeliveryMethodsModal } from '../../../components/customers/DeliveryMethodsModal';

const methods = [
  { id: 1, name: 'Pickup', position: 0, contacts_count: 0 },
  { id: 2, name: 'Nova Poshta', position: 1, contacts_count: 3 },
];

describe('DeliveryMethodsModal', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'getDeliveryMethods').mockResolvedValue(methods);
  });

  it('adds, renames and moves methods', async () => {
    const create = vi
      .spyOn(api, 'createDeliveryMethod')
      .mockResolvedValue({ id: 3, name: 'Meest', position: 2, contacts_count: 0 });
    const rename = vi.spyOn(api, 'renameDeliveryMethod').mockResolvedValue({ ...methods[0], name: 'Self pickup' });
    const reorder = vi.spyOn(api, 'reorderDeliveryMethods').mockResolvedValue(methods);
    render(<DeliveryMethodsModal onClose={() => {}} />);
    const pickup = await screen.findByDisplayValue('Pickup');
    fireEvent.change(pickup, { target: { value: 'Self pickup' } });
    fireEvent.blur(pickup);
    await waitFor(() => expect(rename).toHaveBeenCalledWith(1, 'Self pickup'));
    fireEvent.click(screen.getByRole('button', { name: 'Move Pickup down' }));
    await waitFor(() => expect(reorder).toHaveBeenCalledWith([2, 1]));
    fireEvent.change(screen.getByLabelText('New delivery method'), { target: { value: 'Meest' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith('Meest'));
  });

  it('cannot delete a method contacts use, and says why to a screen reader too', async () => {
    const del = vi.spyOn(api, 'deleteDeliveryMethod').mockResolvedValue({ message: 'ok' });
    render(<DeliveryMethodsModal onClose={() => {}} />);
    const blocked = await screen.findByRole('button', { name: 'Delete Nova Poshta' });
    expect(blocked).toBeDisabled();
    expect(blocked).toHaveAccessibleDescription('Used by 3 contacts — replace it there first');
    fireEvent.click(screen.getByRole('button', { name: 'Delete Pickup' }));
    await waitFor(() => expect(del).toHaveBeenCalledWith(1));
  });

  it('says «contact» for one', async () => {
    vi.spyOn(api, 'getDeliveryMethods').mockResolvedValue([{ id: 4, name: 'Meest', position: 0, contacts_count: 1 }]);
    render(<DeliveryMethodsModal onClose={() => {}} />);
    expect(await screen.findByRole('button', { name: 'Delete Meest' })).toHaveAccessibleDescription(
      'Used by 1 contact — replace it there first',
    );
  });

  it('a blanked or refused name goes back to the one the server holds', async () => {
    const rename = vi
      .spyOn(api, 'renameDeliveryMethod')
      .mockRejectedValue(new Error('A delivery method with this name already exists'));
    render(<DeliveryMethodsModal onClose={() => {}} />);
    const pickup = await screen.findByDisplayValue('Pickup');
    fireEvent.change(pickup, { target: { value: '   ' } });
    fireEvent.blur(pickup);
    expect(pickup).toHaveValue('Pickup');
    expect(rename).not.toHaveBeenCalled();
    fireEvent.change(pickup, { target: { value: 'Nova Poshta' } });
    fireEvent.blur(pickup);
    await waitFor(() => expect(rename).toHaveBeenCalledWith(1, 'Nova Poshta'));
    await waitFor(() => expect(pickup).toHaveValue('Pickup'));
  });

  it('a change refreshes an open customer page as well as the lists', async () => {
    vi.spyOn(api, 'renameDeliveryMethod').mockResolvedValue({ ...methods[0], name: 'Self pickup' });
    const invalidate = vi.spyOn(QueryClient.prototype, 'invalidateQueries');
    render(<DeliveryMethodsModal onClose={() => {}} />);
    const pickup = await screen.findByDisplayValue('Pickup');
    fireEvent.change(pickup, { target: { value: 'Self pickup' } });
    fireEvent.blur(pickup);
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['customer'] }));
  });
});
