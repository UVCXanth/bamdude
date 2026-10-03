/**
 * The delivery reference (WS-13 E11 G, F21): a WorkshopDialog whose every action writes at
 * once by its own button — an explicit rename in the row (Enter / «Save», Escape or
 * «Cancel» undo the row only), a delete confirmed and refused while contacts use the method
 * (the reason on screen, not only in a title), an add whose refusal stays under its field —
 * with its reads' states and the rights its writers take (`projects:update`, G07).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { render } from '../../utils';
import { server } from '../../mocks/server';
import { api, ApiError } from '../../../api/client';
import { DeliveryMethodsModal } from '../../../components/customers/DeliveryMethodsModal';

const methods = [
  { id: 1, name: 'Pickup', position: 0, contacts_count: 0 },
  { id: 2, name: 'Nova Poshta', position: 1, contacts_count: 3 },
];
const rowOf = (name: string) => screen.getByTestId(`method-row-${name}`);

function asReader() {
  server.use(
    http.get('/api/v1/auth/me', () =>
      HttpResponse.json({
        id: 2,
        username: 'viewer',
        role: 'user',
        is_active: true,
        is_admin: false,
        groups: [{ id: 2, name: 'Viewers' }],
        permissions: ['projects:read'],
        created_at: '2024-01-01T00:00:00Z',
      }),
    ),
  );
}

describe('DeliveryMethodsModal', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'getDeliveryMethods').mockResolvedValue(methods);
  });

  it('the frame: «Delivery methods», what they are for, and «Done»', async () => {
    const onClose = vi.fn();
    render(<DeliveryMethodsModal onClose={onClose} />);
    const dialog = screen.getByRole('dialog', { name: 'Delivery methods' });
    expect(dialog).toHaveAccessibleDescription('Used by customers’ contacts and dispatch notes');
    await screen.findByTestId('method-row-Pickup');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  describe('the rename (G02)', () => {
    it('is explicit: the row\'s field, Enter saves — never on losing focus', async () => {
      const rename = vi.spyOn(api, 'renameDeliveryMethod').mockResolvedValue({ ...methods[0], name: 'Self pickup' });
      render(<DeliveryMethodsModal onClose={() => {}} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Rename Pickup' }));
      const field = within(rowOf('Pickup')).getByLabelText('Delivery method name');
      expect(field).toHaveFocus();
      fireEvent.change(field, { target: { value: 'Self pickup' } });
      fireEvent.blur(field);
      expect(rename).not.toHaveBeenCalled();
      fireEvent.submit(field);
      await waitFor(() => expect(rename).toHaveBeenCalledWith(1, 'Self pickup'));
    });

    it('Escape undoes the row only; the next Escape closes the reference', async () => {
      const onClose = vi.fn();
      render(<DeliveryMethodsModal onClose={onClose} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Rename Pickup' }));
      const field = within(rowOf('Pickup')).getByLabelText('Delivery method name');
      fireEvent.change(field, { target: { value: 'X' } });
      fireEvent.keyDown(field, { key: 'Escape' });
      expect(within(rowOf('Pickup')).queryByLabelText('Delivery method name')).toBeNull();
      expect(onClose).not.toHaveBeenCalled();
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('an unchanged name sends nothing; a taken one is said under the row, the name kept, the cursor back in it', async () => {
      const rename = vi
        .spyOn(api, 'renameDeliveryMethod')
        .mockRejectedValue(new ApiError('A delivery method with this name already exists', 409));
      render(<DeliveryMethodsModal onClose={() => {}} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Rename Pickup' }));
      let field = within(rowOf('Pickup')).getByLabelText('Delivery method name');
      fireEvent.submit(field);
      expect(rename).not.toHaveBeenCalled();
      fireEvent.click(await screen.findByRole('button', { name: 'Rename Pickup' }));
      field = within(rowOf('Pickup')).getByLabelText('Delivery method name');
      fireEvent.change(field, { target: { value: 'Nova Poshta' } });
      const save = within(rowOf('Pickup')).getByRole('button', { name: 'Save' });
      save.focus();
      fireEvent.click(save);
      expect(await within(rowOf('Pickup')).findByText('A delivery method with this name already exists')).toBeInTheDocument();
      expect(within(rowOf('Pickup')).getByLabelText('Delivery method name')).toHaveValue('Nova Poshta');
      await waitFor(() => expect(within(rowOf('Pickup')).getByLabelText('Delivery method name')).toHaveFocus());
    });

    it('under its request nothing closes the reference', async () => {
      vi.spyOn(api, 'renameDeliveryMethod').mockReturnValue(new Promise(() => {}) as never);
      const onClose = vi.fn();
      render(<DeliveryMethodsModal onClose={onClose} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Rename Pickup' }));
      fireEvent.change(within(rowOf('Pickup')).getByLabelText('Delivery method name'), { target: { value: 'Self' } });
      const save = within(rowOf('Pickup')).getByRole('button', { name: 'Save' });
      act(() => {
        save.click();
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  it('moves a method up and down', async () => {
    const reorder = vi.spyOn(api, 'reorderDeliveryMethods').mockResolvedValue(methods);
    render(<DeliveryMethodsModal onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Move Pickup down' }));
    await waitFor(() => expect(reorder).toHaveBeenCalledWith([2, 1]));
  });

  it('a move holds every move until the list has the new order — and «Done» does not close under it (G06)', async () => {
    vi.spyOn(api, 'getDeliveryMethods').mockResolvedValueOnce(methods).mockReturnValue(new Promise(() => {}) as never);
    const reorder = vi.spyOn(api, 'reorderDeliveryMethods').mockResolvedValue(undefined as never);
    const onClose = vi.fn();
    render(<DeliveryMethodsModal onClose={onClose} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Move Nova Poshta up' }));
    await waitFor(() => expect(reorder).toHaveBeenCalledTimes(1));
    // The move answered; the list it is computed from has not yet.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByRole('button', { name: 'Move Pickup down' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a refused move says so in the reference — never silently', async () => {
    vi.spyOn(api, 'reorderDeliveryMethods').mockRejectedValue(
      new ApiError('The order must name every delivery method exactly once', 422),
    );
    render(<DeliveryMethodsModal onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Move Pickup down' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The order must name every delivery method exactly once');
  });

  describe('the delete (G03)', () => {
    it('a method contacts use cannot go — the reason is on screen and describes the button', async () => {
      render(<DeliveryMethodsModal onClose={() => {}} />);
      const blocked = await screen.findByRole('button', { name: 'Delete Nova Poshta' });
      expect(blocked).toBeDisabled();
      expect(within(rowOf('Nova Poshta')).getByText('Used by 3 contacts — replace it there first')).toBeVisible();
      expect(blocked).toHaveAccessibleDescription('Used by 3 contacts — replace it there first');
    });

    it('says «contact» for one', async () => {
      vi.spyOn(api, 'getDeliveryMethods').mockResolvedValue([{ id: 4, name: 'Meest', position: 0, contacts_count: 1 }]);
      render(<DeliveryMethodsModal onClose={() => {}} />);
      expect(await screen.findByRole('button', { name: 'Delete Meest' })).toHaveAccessibleDescription(
        'Used by 1 contact — replace it there first',
      );
    });

    it('a free one asks first, naming it; a refusal stays in the confirmation', async () => {
      const del = vi
        .spyOn(api, 'deleteDeliveryMethod')
        .mockRejectedValueOnce(new ApiError('Contacts using this delivery method: 1', 409))
        .mockResolvedValueOnce({ message: 'ok' });
      render(<DeliveryMethodsModal onClose={() => {}} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Delete Pickup' }));
      const confirm = await screen.findByRole('dialog', { name: 'Delete the method «Pickup»?' });
      expect(confirm).toHaveTextContent('The method leaves the reference. No contact uses it; issued dispatch notes keep its name.');
      expect(del).not.toHaveBeenCalled();
      fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));
      expect(await within(confirm).findByRole('alert')).toHaveTextContent('Contacts using this delivery method: 1');
      fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));
      await waitFor(() => expect(del).toHaveBeenCalledTimes(2));
      expect(del).toHaveBeenLastCalledWith(1);
    });
  });

  it('after a delete the cursor is in «New delivery method» — not lost with the row', async () => {
    vi.spyOn(api, 'getDeliveryMethods').mockResolvedValueOnce(methods).mockResolvedValue([methods[1]]);
    vi.spyOn(api, 'deleteDeliveryMethod').mockResolvedValue(undefined as never);
    render(<DeliveryMethodsModal onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Pickup' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete the method «Pickup»?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Delete the method «Pickup»?' })).toBeNull());
    await waitFor(() => expect(screen.getByLabelText('New delivery method')).toHaveFocus());
  });

  it('an add: its refusal stays under its field with the cursor back in it (G04)', async () => {
    const create = vi
      .spyOn(api, 'createDeliveryMethod')
      .mockRejectedValueOnce(new ApiError('A delivery method with this name already exists', 409))
      .mockResolvedValueOnce({ id: 3, name: 'Meest', position: 2, contacts_count: 0 });
    render(<DeliveryMethodsModal onClose={() => {}} />);
    const field = await screen.findByLabelText('New delivery method');
    fireEvent.change(field, { target: { value: 'Pickup' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('A delivery method with this name already exists')).toBeInTheDocument();
    await waitFor(() => expect(field).toHaveFocus());
    fireEvent.change(field, { target: { value: 'Meest' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(create).toHaveBeenLastCalledWith('Meest'));
    await waitFor(() => expect(field).toHaveValue(''));
  });

  describe('its reads (G05)', () => {
    it('a failed read says so with a retry — never «no methods»', async () => {
      const read = vi
        .spyOn(api, 'getDeliveryMethods')
        .mockRejectedValueOnce(new Error('HTTP 500'))
        .mockResolvedValueOnce(methods);
      render(<DeliveryMethodsModal onClose={() => {}} />);
      const failed = await screen.findByRole('alert');
      expect(failed).toHaveTextContent('Could not read the delivery methods');
      expect(screen.queryByText('No methods yet')).toBeNull();
      fireEvent.click(within(failed).getByRole('button', { name: 'Retry' }));
      expect(await screen.findByTestId('method-row-Pickup')).toBeInTheDocument();
      expect(read).toHaveBeenCalledTimes(2);
    });

    it('a failed refresh keeps the list it had and says so', async () => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
      vi.spyOn(api, 'getDeliveryMethods').mockResolvedValueOnce(methods).mockRejectedValueOnce(new Error('HTTP 500'));
      render(
        <QueryClientProvider client={client}>
          <DeliveryMethodsModal onClose={() => {}} />
        </QueryClientProvider>,
      );
      await screen.findByTestId('method-row-Pickup');
      await act(async () => {
        await client.invalidateQueries({ queryKey: ['delivery-methods'] });
      });
      expect(await screen.findByText('Could not refresh')).toBeInTheDocument();
      expect(screen.getByTestId('method-row-Pickup')).toBeInTheDocument();
    });

    it('a truly empty reference says so', async () => {
      vi.spyOn(api, 'getDeliveryMethods').mockResolvedValue([]);
      render(<DeliveryMethodsModal onClose={() => {}} />);
      expect(await screen.findByText('No methods yet')).toBeInTheDocument();
    });
  });

  it('without projects:update the reference is read only (G07)', async () => {
    asReader();
    render(<DeliveryMethodsModal onClose={() => {}} />);
    await screen.findByTestId('method-row-Pickup');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Rename Pickup' })).toBeNull());
    expect(screen.queryByRole('button', { name: 'Delete Pickup' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Move Pickup down' })).toBeNull();
    expect(screen.queryByLabelText('New delivery method')).toBeNull();
  });

  it('a change refreshes an open customer page as well as the lists', async () => {
    vi.spyOn(api, 'renameDeliveryMethod').mockResolvedValue({ ...methods[0], name: 'Self pickup' });
    const invalidate = vi.spyOn(QueryClient.prototype, 'invalidateQueries');
    render(<DeliveryMethodsModal onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Rename Pickup' }));
    const field = within(rowOf('Pickup')).getByLabelText('Delivery method name');
    fireEvent.change(field, { target: { value: 'Self pickup' } });
    fireEvent.submit(field);
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['customer'] }));
  });
});
