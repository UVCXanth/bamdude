import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { render } from '../../utils';
import { api } from '../../../api/client';
import { OrderModal } from '../../../components/projects/OrderModal';

// A full `Order` as the detail page would pass it — `due_date` is a datetime
// string (backend `ProjectResponse.due_date` is `datetime`), never a bare
// `YYYY-MM-DD`.
const order = {
  id: 5,
  name: 'Ten flasks',
  customer_id: 2,
  customer_name: 'ACME',
  description: 'Existing description',
  color: '#00ae42',
  status: 'active',
  notes: null,
  attachments: null,
  tags: null,
  due_date: '2026-09-10T00:00:00',
  priority: 'normal',
  price: 120,
  url: 'https://example.com',
  cover_image_filename: null,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
  lines: [],
  procurement: [],
  figures: {},
  other_archive_ids: [],
} as never;

describe('OrderModal', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'getCustomers').mockResolvedValue([{ id: 2, name: 'ACME', figures: {} }] as never);
    vi.spyOn(api, 'getFulfilment').mockResolvedValue({
      lines: [],
      ordered: 10,
      issued: 0,
      held: 0,
      fully_issued: false,
      closes_to_stock: false,
      can_complete: false,
      can_assemble: 0,
      can_receive: 0,
      can_issue: 0,
      recipient: { name: null, phone: null, delivery_method: null, delivery_details: null },
    });
  });

  it('shows the stored due date and sends no request when nothing was touched', async () => {
    const update = vi.spyOn(api, 'updateOrder').mockResolvedValue(order);
    const onClose = vi.fn();
    render(<OrderModal order={order} onClose={onClose} />);

    // The API sends a full datetime; the date input must show only the date part.
    expect(screen.getByLabelText('Deadline')).toHaveValue('2026-09-10');

    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    // An untouched edit sends no PATCH at all (WS-13 E6 C05) — not even an empty one.
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(update).not.toHaveBeenCalled();
  });

  // ---- WS-13 E2 T4: the Workshop frame, nothing else ----

  it('sits in the Workshop frame, with its actions in the dialog footer and the submit bound to the one form', () => {
    render(<OrderModal order={order} onClose={() => {}} />);

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveClass('workshop');
    const save = screen.getByRole('button', { name: /save/i }) as HTMLButtonElement;
    const form = screen.getByLabelText(/name/i).closest('form') as HTMLFormElement;
    // Outside the form (the footer is the dialog's, not the scrolling body's)…
    expect(form.contains(save)).toBe(false);
    // …and still its submit button.
    expect(save.form).toBe(form);
    expect(dialog.querySelectorAll('form')).toHaveLength(1);
  });

  it('a refusal keeps the dialog and what was typed, says why, and lets the operator try again', async () => {
    const onClose = vi.fn();
    const update = vi
      .spyOn(api, 'updateOrder')
      .mockRejectedValueOnce(new Error('The order changed while you were editing it'))
      .mockResolvedValueOnce(order);
    render(<OrderModal order={order} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Twelve flasks' } });

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(await screen.findByText('The order changed while you were editing it')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText(/name/i)).toHaveValue('Twelve flasks');
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenLastCalledWith(5, { name: 'Twelve flasks' });
  });

  it('sends one request however often the button is pressed while it is pending', async () => {
    let answer!: (value: never) => void;
    const update = vi.spyOn(api, 'updateOrder').mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    render(<OrderModal order={order} onClose={() => {}} />);
    const save = screen.getByRole('button', { name: /save/i });
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Twelve flasks' } });

    fireEvent.click(save);
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    fireEvent.click(save);
    fireEvent.submit(screen.getByLabelText(/name/i).closest('form') as HTMLFormElement);

    expect(update).toHaveBeenCalledTimes(1);
    // …and the way out is locked while it is in flight.
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
    answer(order);
  });
});

describe('OrderModal · completing', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'getCustomers').mockResolvedValue([{ id: 2, name: 'ACME', figures: {} }] as never);
  });

  it('offers «Completed» on an active order whatever is issued — the door is «Stock & issue» (WS-13 E6 C06, R01)', () => {
    // The old gate on `can_complete` closed the option; now the form opens the issue
    // dialog, whose own rule decides — a batch there may receive and issue what is left.
    const getState = vi.spyOn(api, 'getFulfilment');
    render(<OrderModal order={order} onClose={() => {}} />);
    expect(screen.getByRole('option', { name: 'Completed' })).toBeEnabled();
    expect(getState).not.toHaveBeenCalled();
  });
});
