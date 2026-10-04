/**
 * The order form (WS-13 E6 §C): the mockup's field order on the Workshop grid, a named
 * colour radio group with an explicit «No colour», a status that never goes over the
 * wire but routes into the action model (C06, R01), a form session whose base is read
 * once (C07, R03), a refusal kept in the dialog with focus on a live control (C08),
 * and a new order opened as soon as it exists (C09).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { render } from '../../utils';
import { api, ApiError } from '../../../api/client';
import type { Order } from '../../../api/client';
import { OrderModal } from '../../../components/projects/OrderModal';
import { getColorName } from '../../../utils/colors';
import { makeOrder } from '../../fixtures/orderDetail';

const ORDER: Order = makeOrder({
  id: 5,
  code: 'OR-0005',
  name: 'Ten flasks',
  customer_id: 2,
  customer_name: 'ACME',
  contact_id: null,
  description: 'Blue ones',
  color: '#4eac48',
  tags: 'series',
  due_date: '2026-09-10T00:00:00',
  priority: 'normal',
  price: 120,
  url: null,
  status: 'active',
  responsible_id: 1,
  responsible_name: 'admin',
});

const grabbed = vi.hoisted(() => ({ client: null as QueryClient | null }));
function Grab() {
  const client = useQueryClient();
  useEffect(() => {
    grabbed.client = client;
  }, [client]);
  return null;
}

beforeEach(() => {
  vi.restoreAllMocks();
  grabbed.client = null;
  vi.spyOn(api, 'getCustomerOptions').mockResolvedValue([{ id: 2, name: 'ACME', contacts: [], figures: {} }] as never);
  vi.spyOn(api, 'getOrderAssignees').mockResolvedValue([{ id: 1, username: 'admin' }]);
  vi.spyOn(api, 'getSettings').mockResolvedValue({ currency: 'USD' } as never);
});

const labelsInOrder = () =>
  Array.from(screen.getByRole('dialog').querySelectorAll('form label'))
    .map((l) => l.textContent?.trim())
    // The colour swatches are labels too — named by their radios, not by text.
    .filter(Boolean);

describe('OrderModal · layout (C01–C02)', () => {
  it('titles a new order and says lines come after', () => {
    render(<OrderModal order={null} onClose={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: 'New order' });
    expect(dialog).toHaveTextContent('Lines are added after the order is created');
  });

  it('lays an edit out in the mockup’s order, the code under the title', async () => {
    render(<OrderModal order={ORDER} onClose={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: 'Edit order' });
    expect(dialog).toHaveTextContent('OR-0005');
    await waitFor(() =>
      expect(labelsInOrder()).toEqual([
        'Name',
        'Customer',
        'Responsible',
        'Contact person',
        'Deadline',
        'Priority',
        'Price, $',
        'Tags',
        'Card colour',
        'Description',
        'Link',
        'Status',
      ]),
    );
    expect(screen.getByLabelText('Name')).toHaveAttribute('maxlength', '255');
    expect(screen.getByLabelText('Tags')).toHaveAttribute('placeholder', 'comma-separated');
  });

  it('shows no contact field without a customer', () => {
    render(<OrderModal order={null} onClose={() => {}} />);
    expect(screen.queryByLabelText('Contact person')).not.toBeInTheDocument();
  });
});

describe('OrderModal · first focus (the mockup\'s openDialog)', () => {
  it('puts the cursor in the name of a new order', async () => {
    render(<OrderModal order={null} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveFocus());
  });

  it('puts the cursor in the name of the order being edited', async () => {
    render(<OrderModal order={ORDER} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveFocus());
  });
});

describe('OrderModal · link (G)', () => {
  it('holds the link to the column’s 2048 characters', () => {
    render(<OrderModal order={null} onClose={() => {}} />);
    expect(screen.getByLabelText('Link')).toHaveAttribute('maxLength', '2048');
  });
});

describe('OrderModal · colour (C03)', () => {
  it('is a named radio group with «No colour», the first colour chosen for a new order', () => {
    render(<OrderModal order={null} onClose={() => {}} />);
    const group = screen.getByRole('radiogroup', { name: 'Card colour' });
    const radios = within(group).getAllByRole('radio');
    expect(radios).toHaveLength(10);
    expect(radios[0]).toHaveAccessibleName('No colour');
    for (const radio of radios) expect(radio).toHaveAccessibleName(/\S/);
    expect(radios[1]).toBeChecked();
  });

  it('chooses «No colour» for an order without one; a round trip back to it sends no colour change', async () => {
    const update = vi.spyOn(api, 'updateOrder').mockResolvedValue(ORDER);
    render(<OrderModal order={{ ...ORDER, color: null }} onClose={() => {}} />);
    expect(screen.getByRole('radio', { name: 'No colour' })).toBeChecked();
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Card colour' })).getAllByRole('radio')[2]);
    fireEvent.click(screen.getByRole('radio', { name: 'No colour' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ten flasks!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(5, { name: 'Ten flasks!' }));
  });

  it('gives every swatch a name of its own — two colours named alike carry their hex', () => {
    render(<OrderModal order={{ ...ORDER, color: '#6c6c6c' }} onClose={() => {}} />);
    const names = within(screen.getByRole('radiogroup', { name: 'Card colour' }))
      .getAllByRole('radio')
      .map((radio) => radio.getAttribute('aria-label'));
    expect(new Set(names).size).toBe(names.length);
    // The palette's two ambers fall back to one coarse family name; the hex tells them apart.
    expect(names).toContain(`${getColorName('#d0863c')} (#D0863C)`);
    expect(names).toContain(`${getColorName('#c9a23f')} (#C9A23F)`);
  });

  it('keeps a colour from outside the palette as one more, chosen swatch', () => {
    render(<OrderModal order={{ ...ORDER, color: '#6c6c6c' }} onClose={() => {}} />);
    const radios = within(screen.getByRole('radiogroup', { name: 'Card colour' })).getAllByRole('radio');
    expect(radios).toHaveLength(11);
    expect(radios[10]).toBeChecked();
  });
});

describe('OrderModal · values (C05)', () => {
  it('trims the name, sends an empty price as null and 0 as 0, the date as the calendar day', async () => {
    const create = vi.spyOn(api, 'createOrder').mockResolvedValue({ ...ORDER, id: 42 });
    render(<OrderModal order={null} onClose={() => {}} />);
    const submit = screen.getByRole('button', { name: 'Create' });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '   ' } });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  Lamps ' } });
    fireEvent.change(screen.getByLabelText('Price, $'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('Deadline'), { target: { value: '2026-10-02' } });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Lamps', price: 0, due_date: '2026-10-02', url: null })),
    );
  });

  it('sends nothing at all for an untouched edit', async () => {
    const update = vi.spyOn(api, 'updateOrder');
    const onClose = vi.fn();
    render(<OrderModal order={ORDER} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(update).not.toHaveBeenCalled();
  });
});

describe('OrderModal · status (C06, R01)', () => {
  const statusSelect = () => screen.getByLabelText('Status') as HTMLSelectElement;
  const optionDisabled = (value: string) =>
    (Array.from(statusSelect().options).find((o) => o.value === value) as HTMLOptionElement).disabled;

  it('never writes «completed»: it opens «Stock & issue» through the model, without a PATCH', async () => {
    const update = vi.spyOn(api, 'updateOrder');
    const onStatusAction = vi.fn();
    const onClose = vi.fn();
    render(<OrderModal order={ORDER} onClose={onClose} onStatusAction={onStatusAction} />);
    expect(optionDisabled('completed')).toBe(false);
    fireEvent.change(statusSelect(), { target: { value: 'completed' } });
    expect(screen.getByRole('dialog')).toHaveTextContent('the status change is a step of its own');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onStatusAction).toHaveBeenCalledWith(expect.objectContaining({ id: 5 }), 'completed'));
    expect(update).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('saves the fields first, then hands the NEW order to the next step', async () => {
    const update = vi.spyOn(api, 'updateOrder').mockResolvedValue({ ...ORDER, name: 'Twelve flasks', customer_name: 'Globex' });
    const onStatusAction = vi.fn();
    render(<OrderModal order={ORDER} onClose={() => {}} onStatusAction={onStatusAction} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Twelve flasks' } });
    fireEvent.change(statusSelect(), { target: { value: 'cancelled' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(onStatusAction).toHaveBeenCalledWith(expect.objectContaining({ name: 'Twelve flasks', customer_name: 'Globex' }), 'cancelled'),
    );
    expect(update).toHaveBeenCalledWith(5, { name: 'Twelve flasks' });
  });

  it('runs no next step when the fields are refused', async () => {
    vi.spyOn(api, 'updateOrder').mockRejectedValue(new ApiError('Contact 3 does not belong to this order’s customer', 422));
    const onStatusAction = vi.fn();
    render(<OrderModal order={ORDER} onClose={() => {}} onStatusAction={onStatusAction} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Twelve flasks' } });
    fireEvent.change(statusSelect(), { target: { value: 'cancelled' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('does not belong');
    expect(onStatusAction).not.toHaveBeenCalled();
  });

  it('offers a completed order reopening only, and says why', () => {
    render(<OrderModal order={{ ...ORDER, status: 'completed' }} onClose={() => {}} />);
    expect(optionDisabled('active')).toBe(false);
    expect(optionDisabled('cancelled')).toBe(true);
    expect(screen.getByRole('dialog')).toHaveTextContent('reopen the order first');
  });

  it('offers a cancelled order reopening only', async () => {
    const onStatusAction = vi.fn();
    render(<OrderModal order={{ ...ORDER, status: 'cancelled' }} onClose={() => {}} onStatusAction={onStatusAction} />);
    expect(optionDisabled('completed')).toBe(true);
    fireEvent.change(statusSelect(), { target: { value: 'active' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onStatusAction).toHaveBeenCalledWith(expect.objectContaining({ id: 5 }), 'active'));
  });

  it('opens no step for an unchanged status', async () => {
    vi.spyOn(api, 'updateOrder').mockResolvedValue({ ...ORDER, name: 'Twelve flasks' });
    const onStatusAction = vi.fn();
    const onClose = vi.fn();
    render(<OrderModal order={ORDER} onClose={onClose} onStatusAction={onStatusAction} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Twelve flasks' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onStatusAction).not.toHaveBeenCalled();
  });
});

describe('OrderModal · a session read by id (C07, R03)', () => {
  it('reads the full order, then keeps what was typed when it is read again', async () => {
    const get = vi
      .spyOn(api, 'getOrder')
      .mockResolvedValueOnce(ORDER)
      .mockResolvedValue({ ...ORDER, name: 'Renamed elsewhere', description: 'Red ones' });
    const update = vi.spyOn(api, 'updateOrder').mockResolvedValue(ORDER);
    render(
      <>
        <Grab />
        <OrderModal orderId={5} onClose={() => {}} />
      </>,
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(await screen.findByLabelText('Description')).toHaveValue('Blue ones');
    fireEvent.change(screen.getByLabelText('Tags'), { target: { value: 'series, PETG' } });

    await act(async () => {
      await grabbed.client?.invalidateQueries({ queryKey: ['project', 5] });
    });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText('Name')).toHaveValue('Ten flasks');
    expect(screen.getByLabelText('Description')).toHaveValue('Blue ones');
    expect(screen.getByLabelText('Tags')).toHaveValue('series, PETG');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(5, { tags: 'series, PETG' }));
  });

  it('says when the order could not be read, and reads it again on request', async () => {
    const get = vi.spyOn(api, 'getOrder').mockRejectedValueOnce(new Error('Gateway timeout')).mockResolvedValue(ORDER);
    render(<OrderModal orderId={5} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByLabelText('Description')).toHaveValue('Blue ones');
    expect(get).toHaveBeenCalledTimes(2);
  });
});

describe('OrderModal · refusal and success (C08–C09)', () => {
  it('keeps a refusal in the dialog and focus on the primary button', async () => {
    vi.spyOn(api, 'updateOrder').mockRejectedValue(new ApiError('Order not found', 404));
    render(<OrderModal order={ORDER} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Twelve flasks' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Order not found');
    expect(screen.getByLabelText('Name')).toHaveValue('Twelve flasks');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Save' })));
  });

  it('opens a new order as soon as it exists', async () => {
    vi.spyOn(api, 'createOrder').mockResolvedValue({ ...ORDER, id: 42 });
    const onClose = vi.fn();
    render(<OrderModal order={null} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Lamps' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(window.location.pathname).toBe('/projects/42'));
    expect(onClose).toHaveBeenCalled();
  });
});
