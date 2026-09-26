import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
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
    fireEvent.click(screen.getAllByRole('button', { name: 'Move down' })[0]);
    await waitFor(() => expect(reorder).toHaveBeenCalledWith([2, 1]));
    fireEvent.change(screen.getByLabelText('New delivery method'), { target: { value: 'Meest' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith('Meest'));
  });

  it('cannot delete a method contacts use, and says why', async () => {
    const del = vi.spyOn(api, 'deleteDeliveryMethod').mockResolvedValue({ message: 'ok' });
    render(<DeliveryMethodsModal onClose={() => {}} />);
    const row = (await screen.findByDisplayValue('Nova Poshta')).closest('li')!;
    const blocked = within(row).getByRole('button', { name: 'Delete' });
    expect(blocked).toBeDisabled();
    expect(blocked).toHaveAttribute('title', 'Used by 3 contacts — replace it there first');
    const free = within((await screen.findByDisplayValue('Pickup')).closest('li')!).getByRole('button', {
      name: 'Delete',
    });
    fireEvent.click(free);
    await waitFor(() => expect(del).toHaveBeenCalledWith(1));
  });
});
